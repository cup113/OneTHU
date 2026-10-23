#!/usr/bin/env python3
"""OneTHU 安卓发布签名凭据落地：生成 keystore，并把 4 个环境变量写成本机文件。

`apps/desktop/scripts/build-release-apk.sh` 的签名吃 4 个变量：
`ONETHU_KEYSTORE` / `ONETHU_KS_PASS` / `ONETHU_KEY_PASS` / `ONETHU_KEY_ALIAS`。
手工填这四个值容易出错（尤其口令进了 argv 或误入仓库），所以统一由本脚本生成。

红线（改动前先读）：
1. **口令只落本机文件**：不进 argv（keytool 用 `-storepass:env` / `-keypass:env`）、
   不进仓库、不回显；文件权限收到 0600（POSIX）或仅当前用户（Windows ACL）。
2. **已存在的 keystore 绝不覆盖**：换库等于已安装的安卓包无法覆盖升级。要沿用旧库走 `--reuse`。
3. 脚本本身不含任何秘密，可以入库；生成的目录默认在仓库之外（`~/.onethu/android-signing`）。

用法：
    python tools/android-signing.py                       # 生成到默认目录
    python tools/android-signing.py --dir D:\\keys\\onethu   # 生成到指定目录
    python tools/android-signing.py --reuse --keystore <路径>   # 只重写环境变量文件
    python tools/android-signing.py --self-test            # 临时目录里跑一遍自检

`--reuse` 的口令从环境变量 `ONETHU_KS_PASS` 读，缺省时交互式询问（不回显）。
`ONETHU_KEY_PASS` 与 `ONETHU_KS_PASS` **同值**：PKCS12 只能有一个口令，keytool 会忽略
`-keypass`，分开发两个口令会让 apksigner 解不开私钥（`Given final block not properly
padded`）。生成/沿用之后本脚本会用 jarsigner 真解一次私钥，确认这份凭据能用。
生成后：
    bash:       source "<目录>/android-signing.env"
    PowerShell: . "<目录>/android-signing.ps1"
    cmd:        call "<目录>\\android-signing.cmd"
"""

from __future__ import annotations

import argparse
import getpass
import os
import re
import secrets
import shutil
import string
import subprocess
import sys
import uuid
import zipfile
from dataclasses import dataclass
from pathlib import Path

ENV_KEYSTORE = "ONETHU_KEYSTORE"
ENV_STORE_PASS = "ONETHU_KS_PASS"
ENV_KEY_PASS = "ONETHU_KEY_PASS"
ENV_ALIAS = "ONETHU_KEY_ALIAS"
DEFAULT_ALIAS = "onethu-release"
DEFAULT_DIR = Path.home() / ".onethu" / "android-signing"
KEYSTORE_NAME = "onethu-release.keystore"
ENV_FILE = "android-signing.env"
CMD_FILE = "android-signing.cmd"
PS1_FILE = "android-signing.ps1"
# 只用字母数字：规避 shell/apksigner 的引号与转义差异。40 字符 ≈ 238 bit。
PASSWORD_ALPHABET = string.ascii_letters + string.digits
PASSWORD_LENGTH = 40
FINGERPRINT_RE = re.compile(r"SHA256:\s*([0-9A-F:]{95})")


class SigningError(Exception):
    """可预期的失败：打印人话，退出码 1。"""


@dataclass(frozen=True)
class Credentials:
    keystore: Path
    alias: str
    store_pass: str
    key_pass: str


def log(line: str) -> None:
    print(line, flush=True)


def configure_stdio() -> None:
    """输出固定 UTF-8：Windows 控制台默认 GBK，中文提示在管道/日志里会被解码成乱码。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            try:
                reconfigure(encoding="utf-8", errors="replace")
            except (OSError, ValueError):
                pass


def find_keytool() -> Path:
    """优先 JAVA_HOME（构建脚本也用同一个 JDK 思路），其次 PATH。"""
    java_home = os.environ.get("JAVA_HOME", "").strip()
    if java_home:
        for name in ("keytool.exe", "keytool"):
            candidate = Path(java_home) / "bin" / name
            if candidate.is_file():
                return candidate
    found = shutil.which("keytool")
    if found:
        return Path(found)
    raise SigningError(
        "找不到 keytool：请安装 JDK 17+ 并设置 JAVA_HOME（安卓构建本来就需要 JDK）。"
    )


def run_keytool(args: list[str], *, env: dict[str, str]) -> str:
    """跑 keytool 并返回输出。强制英文输出，避免 zh-CN 机器上的 GBK 乱码干扰解析。"""
    keytool = find_keytool()
    command = [
        str(keytool),
        "-J-Duser.language=en",
        "-J-Duser.country=US",
        *args,
    ]
    result = subprocess.run(
        command,
        env=env,
        stdin=subprocess.DEVNULL,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip().splitlines()
        tail = " | ".join(detail[-3:]) if detail else f"退出码 {result.returncode}"
        raise SigningError(f"keytool 执行失败：{tail}")
    return result.stdout + result.stderr


def random_password() -> str:
    return "".join(secrets.choice(PASSWORD_ALPHABET) for _ in range(PASSWORD_LENGTH))


def fingerprint(creds: Credentials) -> str:
    """读证书 SHA-256（公开信息，用来和旧版本发布包比对签名）。"""
    env = {**os.environ, ENV_STORE_PASS: creds.store_pass}
    out = run_keytool(
        [
            "-list",
            "-v",
            "-keystore",
            str(creds.keystore),
            "-alias",
            creds.alias,
            "-storepass:env",
            ENV_STORE_PASS,
        ],
        env=env,
    )
    match = FINGERPRINT_RE.search(out)
    if not match:
        raise SigningError("没能从 keytool 输出里读到证书指纹")
    return match.group(1)


def find_jarsigner() -> Path:
    """私钥自检要用 jarsigner：它与 apksigner 走同一条 KeyStore.getKey 路径。"""
    java_home = os.environ.get("JAVA_HOME", "").strip()
    if java_home:
        for name in ("jarsigner.exe", "jarsigner"):
            candidate = Path(java_home) / "bin" / name
            if candidate.is_file():
                return candidate
    found = shutil.which("jarsigner")
    if found:
        return Path(found)
    raise SigningError("找不到 jarsigner：需要完整 JDK（不只是 JRE）")


def verify_private_key(creds: Credentials) -> None:
    """真解一次私钥——apksigner 失败的就是这一步。

    PKCS12（JDK 9 起的默认类型）**只能有一个口令**：keytool 对 `-keypass` 是「明确忽略并
    警告」，不是报错，所以生成阶段看不出问题；只有像 apksigner 那样调用
    `KeyStore.getKey(alias, keyPass)` 才会炸：
    `UnrecoverableKeyException: Given final block not properly padded`
    （2026-10-23 分叉包 CI 实测）。jarsigner 走同一条路径，代价约 1 秒，所以每次生成/
    沿用都验一遍，不让一份「看着有、其实打不开」的凭据被写出去。
    """
    jarsigner = find_jarsigner()
    probe = creds.keystore.parent / ".onethu-signing-probe.jar"
    try:
        with zipfile.ZipFile(probe, "w") as jar:
            jar.writestr("META-INF/MANIFEST.MF", "Manifest-Version: 1.0\r\n\r\n")
            jar.writestr("probe.txt", "onethu signing probe\n")
        env = {
            **os.environ,
            ENV_STORE_PASS: creds.store_pass,
            ENV_KEY_PASS: creds.key_pass,
        }
        result = subprocess.run(
            [
                str(jarsigner),
                "-J-Duser.language=en",
                "-J-Duser.country=US",
                "-keystore",
                str(creds.keystore),
                "-storepass:env",
                ENV_STORE_PASS,
                "-keypass:env",
                ENV_KEY_PASS,
                str(probe),
                creds.alias,
            ],
            env=env,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip().splitlines()
            tail = " | ".join(detail[-3:]) if detail else f"退出码 {result.returncode}"
            raise SigningError(
                f"私钥打不开（apksigner 会以同一个错误失败）：{tail}\n"
                "  PKCS12 只有一个口令：ONETHU_KEY_PASS 必须与 ONETHU_KS_PASS 相同。"
            )
    finally:
        probe.unlink(missing_ok=True)


def harden(path: Path) -> tuple[bool, str]:
    """把读写权限收到「只有当前用户」。返回 (是否成功, 失败原因)。

    失败不算致命（文件已经在默认目录里，权限通常本来就只有本人），但必须如实报出来——
    口令就写在里面。"""
    if os.name == "nt":
        user = os.environ.get("USERNAME", "").strip()
        if not user:
            return False, "读不到当前用户名"
        done = subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:(R,W)"],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            check=False,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        if done.returncode == 0:
            return True, ""
        detail = (done.stderr or done.stdout).strip().splitlines()
        return False, detail[0] if detail else f"icacls 退出码 {done.returncode}"
    try:
        path.chmod(0o600)
    except OSError as error:
        return False, str(error)
    return True, ""


def shell_quote(value: str, quote: str = "'") -> str:
    """单引号包裹（POSIX）：值里的单引号用 '\\'' 断开再续。"""
    if quote == "'":
        return "'" + value.replace("'", "'\\''") + "'"
    return '"' + value.replace('"', '\\"') + '"'


def env_lines(creds: Credentials) -> list[tuple[str, str]]:
    return [
        (ENV_KEYSTORE, str(creds.keystore)),
        (ENV_STORE_PASS, creds.store_pass),
        (ENV_KEY_PASS, creds.key_pass),
        (ENV_ALIAS, creds.alias),
    ]


def write_env_files(creds: Credentials) -> list[Path]:
    """写三份等价的环境变量文件：bash / PowerShell / cmd。"""
    header = (
        "# OneTHU 安卓发布签名（本机凭据：勿入库、勿外发）\n"
        "# keystore 丢失或换库后，已安装的安卓包无法覆盖升级。\n"
    )
    pairs = env_lines(creds)
    env_path = creds.keystore.parent / ENV_FILE
    cmd_path = creds.keystore.parent / CMD_FILE
    ps1_path = creds.keystore.parent / PS1_FILE

    env_path.write_text(
        header
        + "".join(f"export {key}={shell_quote(value)}\n" for key, value in pairs),
        encoding="utf-8",
    )
    # 用 "\n"：文本模式会按平台换成 CRLF。直接写 "\r\n" 会在 Windows 上变成 "\r\r\n"（空行）。
    cmd_path.write_text(
        "@echo off\nrem OneTHU 安卓发布签名（本机凭据：勿入库、勿外发）\n"
        + "".join(f'set "{key}={value}"\n' for key, value in pairs),
        encoding="utf-8",
    )
    ps1_path.write_text(
        header
        + "".join(
            f"$env:{key} = '{value.replace(chr(39), chr(39) * 2)}'\n"
            for key, value in pairs
        ),
        encoding="utf-8",
    )
    return [env_path, cmd_path, ps1_path]


def generate(directory: Path, alias: str) -> Credentials:
    keystore = directory / KEYSTORE_NAME
    if keystore.exists():
        raise SigningError(
            f"keystore 已存在，拒绝覆盖：{keystore}\n"
            "  换库会让已安装的安卓包无法覆盖升级。如果要沿用旧库，用 --reuse 只重写环境变量文件；\n"
            "  确实要新建一套，请先备份并删除该文件（或换 --dir）。"
        )
    directory.mkdir(parents=True, exist_ok=True)
    # PKCS12 只有一个口令：keytool 会忽略 -keypass，私钥实际由 store 口令保护。
    # 两个变量必须写同一个值，否则 apksigner 读私钥时抛
    # UnrecoverableKeyException: Given final block not properly padded。
    password = random_password()
    creds = Credentials(
        keystore=keystore,
        alias=alias,
        store_pass=password,
        key_pass=password,
    )
    env = {
        **os.environ,
        ENV_STORE_PASS: creds.store_pass,
        ENV_KEY_PASS: creds.key_pass,
    }
    try:
        run_keytool(
            [
                "-genkeypair",
                "-keystore",
                str(keystore),
                "-alias",
                alias,
                "-keyalg",
                "RSA",
                "-keysize",
                "2048",
                "-validity",
                "10000",
                "-dname",
                "CN=OneTHU, OU=OneTHU, O=OneTHU, L=Beijing, ST=Beijing, C=CN",
                "-storepass:env",
                ENV_STORE_PASS,
                "-keypass:env",
                ENV_KEY_PASS,
            ],
            env=env,
        )
    except SigningError:
        keystore.unlink(missing_ok=True)
        raise
    if not keystore.is_file():
        raise SigningError("keytool 报成功但没有生成 keystore 文件")
    return creds


def reuse_existing(keystore: Path, alias: str) -> Credentials:
    if not keystore.is_file():
        raise SigningError(f"--reuse 指定的 keystore 不存在：{keystore}")
    store_pass = os.environ.get(ENV_STORE_PASS, "")
    if not store_pass:
        if not sys.stdin.isatty():
            raise SigningError(f"请先设置 {ENV_STORE_PASS}（非交互环境不能询问口令）")
        store_pass = getpass.getpass(f"{ENV_STORE_PASS}: ")
    # PKCS12 只有一个口令：私钥跟着 store 口令走。旧文件里若两个值不同（历史上分开发过），
    # 这里按 store 口令收敛，否则写出去的 ONETHU_KEY_PASS 是打不开私钥的假凭据。
    key_pass = store_pass
    creds = Credentials(
        keystore=keystore, alias=alias, store_pass=store_pass, key_pass=key_pass
    )
    fingerprint(creds)  # 口令不对或别名不存在 → 直接失败，别写出一份假凭据
    verify_private_key(creds)  # 再确认私钥真能解开
    return creds


def install(creds: Credentials) -> None:
    # 先把私钥验通再落文件：写出一份打不开的凭据，代价是 20 分钟的 CI 编译白跑一趟。
    verify_private_key(creds)
    paths = write_env_files(creds)
    hardened = [harden(creds.keystore), *(harden(path) for path in paths)]
    cert = fingerprint(creds)

    log(f"✓ keystore：{creds.keystore}")
    log(f"  别名：{creds.alias}")
    log(f"  证书 SHA256：{cert}")
    log("✓ 环境变量文件（本机凭据，勿入库、勿外发）：")
    log(f"  bash       source {shell_quote(str(paths[0]))}")
    log(f"  PowerShell . {shell_quote(str(paths[2]))}")
    log(f"  cmd        call {shell_quote(str(paths[1]), '"')}")
    failed = [reason for ok, reason in hardened if not ok]
    if failed:
        log(
            f"！有文件没能收回权限（{failed[0]}）：口令就在里面，手工确认只有当前用户可读写"
        )
    log("！备份 keystore 与口令：丢失或换库后，已安装的安卓包无法覆盖升级。")


def scratch_dir(base: str | None) -> Path:
    """自检用的临时目录。不用 tempfile.mkdtemp：沙箱下它拿不到可继承的写入 ACE，
    子进程（keytool）会 EACCES。用 os.makedirs 继承父目录权限。"""
    parent = Path(
        base or os.environ.get("X_TEST_TMP") or os.environ.get("TEMP") or "/tmp"
    )
    path = parent / f"onethu-signing-{uuid.uuid4().hex[:12]}"
    os.makedirs(path, exist_ok=True)
    return path


def remove_tree(path: Path) -> None:
    def retry(func, target, _exc):  # type: ignore[no-untyped-def]
        try:
            os.chmod(target, 0o700)
            func(target)
        except OSError:
            pass

    shutil.rmtree(path, onerror=retry)


def self_test() -> None:
    import contextlib
    import io

    scratch = scratch_dir(None)
    try:
        buffer = io.StringIO()
        with contextlib.redirect_stdout(buffer):
            first = generate(scratch, DEFAULT_ALIAS)
            install(first)
        printed = buffer.getvalue()
        assert first.store_pass not in printed, "口令被打印到了标准输出"
        assert first.key_pass not in printed, "口令被打印到了标准输出"
        assert first.keystore.is_file(), "keystore 没生成"
        env_text = (scratch / ENV_FILE).read_text(encoding="utf-8")
        for name in (ENV_KEYSTORE, ENV_STORE_PASS, ENV_KEY_PASS, ENV_ALIAS):
            assert f"export {name}=" in env_text, f"环境变量文件缺少 {name}"
        if os.name != "nt":
            assert (scratch / ENV_FILE).stat().st_mode & 0o777 == 0o600, (
                "环境变量文件权限不是 600"
            )
            assert first.keystore.stat().st_mode & 0o777 == 0o600, (
                "keystore 权限不是 600"
            )

        try:
            generate(scratch, DEFAULT_ALIAS)
        except SigningError:
            pass
        else:
            raise AssertionError("已存在的 keystore 没有被拒绝覆盖")

        before = first.keystore.read_bytes()
        fingerprint(first)
        os.environ[ENV_STORE_PASS] = first.store_pass
        os.environ[ENV_KEY_PASS] = first.key_pass
        try:
            again = reuse_existing(first.keystore, DEFAULT_ALIAS)
            assert again.store_pass == first.store_pass, "--reuse 读到的口令不对"
            assert (scratch / ENV_FILE).read_text(encoding="utf-8") == env_text, (
                "--reuse 重写的内容不一致"
            )
        finally:
            os.environ.pop(ENV_STORE_PASS, None)
            os.environ.pop(ENV_KEY_PASS, None)
        assert first.keystore.read_bytes() == before, "--reuse 不应该改动 keystore"
        assert first.store_pass == first.key_pass, (
            "PKCS12 只能有一个口令：两个环境变量必须同值"
        )

        # 私钥必须真能解开。口令写错时 verify_private_key 要当场失败——
        # apksigner 报 `Given final block not properly padded` 的那一步就是它。
        try:
            verify_private_key(
                Credentials(
                    keystore=first.keystore,
                    alias=first.alias,
                    store_pass=first.store_pass,
                    key_pass="definitely-not-the-password",
                )
            )
        except SigningError:
            pass
        else:
            raise AssertionError("错口令的私钥没有被 verify_private_key 拦下")

        # 旧文件里两个口令不一致时，--reuse 要按 store 口令收敛，
        # 否则写出去的 ONETHU_KEY_PASS 打不开私钥（分叉包 CI 就是这么炸的）。
        os.environ[ENV_STORE_PASS] = first.store_pass
        os.environ[ENV_KEY_PASS] = "stale-different-password"
        try:
            converged = reuse_existing(first.keystore, DEFAULT_ALIAS)
            assert converged.key_pass == first.store_pass, (
                "--reuse 没有按 PKCS12 规则把口令收敛到 store 口令"
            )
        finally:
            os.environ.pop(ENV_STORE_PASS, None)
            os.environ.pop(ENV_KEY_PASS, None)

        # 错口令必须当场失败：否则会写出一份「看着有、其实打不开」的凭据
        os.environ[ENV_STORE_PASS] = "definitely-not-the-password"
        os.environ[ENV_KEY_PASS] = "definitely-not-the-password"
        try:
            reuse_existing(first.keystore, DEFAULT_ALIAS)
        except SigningError:
            pass
        else:
            raise AssertionError("错口令没有被拒绝")
        finally:
            os.environ.pop(ENV_STORE_PASS, None)
            os.environ.pop(ENV_KEY_PASS, None)

        log(
            "✓ 自检通过：生成 / 不覆盖 / 口令不外泄 / 文件权限 / --reuse 一致性 / 错口令拒绝 / "
            "私钥可解密"
        )
    finally:
        remove_tree(scratch)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="生成 OneTHU 安卓发布签名 keystore，并写出 4 个环境变量文件。",
    )
    parser.add_argument(
        "--dir",
        type=Path,
        default=DEFAULT_DIR,
        help=f"keystore 目录（默认 {DEFAULT_DIR}）",
    )
    parser.add_argument(
        "--alias", default=DEFAULT_ALIAS, help=f"签名别名（默认 {DEFAULT_ALIAS}）"
    )
    parser.add_argument(
        "--reuse", action="store_true", help="沿用已有 keystore，只重写环境变量文件"
    )
    parser.add_argument(
        "--keystore", type=Path, default=None, help="配合 --reuse 指定 keystore 路径"
    )
    parser.add_argument(
        "--self-test", action="store_true", help="临时目录里自检，不碰真实凭据"
    )
    args = parser.parse_args(argv)
    configure_stdio()

    try:
        if args.self_test:
            self_test()
            return 0
        if args.reuse:
            keystore = args.keystore or (args.dir / KEYSTORE_NAME)
            install(reuse_existing(keystore, args.alias))
            return 0
        install(generate(args.dir, args.alias))
        return 0
    except SigningError as error:
        print(f"✗ {error}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
