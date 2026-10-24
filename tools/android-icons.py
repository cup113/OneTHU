#!/usr/bin/env python3
"""Sync the existing app logo into Android, or verify compiled APK resources.

Requires ffmpeg and, for APK verification, the SDK's aapt2. Generated Android
projects may contain Tauri defaults, so releases must sync AND check the APK.
"""
import argparse
import pathlib
import re
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ANDROID = "http://schemas.android.com/apk/res/android"
# aapt2 的输出必须按 UTF-8 解码：Windows 默认走 locale（GBK），会 UnicodeDecodeError。


def render(source, target, size):
    subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(source), "-vf",
                    f"scale={size}:{size}:flags=lanczos", "-threads", "1", str(target)], check=True)


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    if not path.exists() or path.read_bytes() != data:
        path.write_bytes(data)


def sync(project, source):
    res = project / "app/src/main/res"
    assert (project / "app/build.gradle.kts").is_file(), "Not a Tauri Android project"
    with tempfile.TemporaryDirectory() as directory:
        png = pathlib.Path(directory) / "icon.png"
        for density, size in DENSITIES.items():
            render(source, png, size)
            for name in ["ic_launcher", "ic_launcher_round"]:
                write(res / f"mipmap-{density}/{name}.png", png.read_bytes())
            # Original logo margins keep the unchanged glyphs within the
            # central 66dp safe zone of the 108dp adaptive icon canvas.
            render(source, png, size * 108 // 48)
            write(res / f"mipmap-{density}/ic_launcher_foreground.png", png.read_bytes())
    adaptive = f'''<adaptive-icon xmlns:android="{ANDROID}">
    <background android:drawable="@color/onethu_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
'''.encode()
    for name in ["ic_launcher", "ic_launcher_round"]:
        write(res / f"mipmap-anydpi-v26/{name}.xml", adaptive)
    write(res / "values/onethu_launcher.xml", b'<resources><color name="onethu_launcher_background">#FF000000</color></resources>\n')
    write(res / "drawable/ic_launcher_background.xml", f'<shape xmlns:android="{ANDROID}"><solid android:color="@color/onethu_launcher_background" /></shape>\n'.encode())
    write(res / "drawable-v24/ic_launcher_foreground.xml", f'<bitmap xmlns:android="{ANDROID}" android:src="@mipmap/ic_launcher_foreground" android:gravity="fill" />\n'.encode())
    manifest = project / "app/src/main/AndroidManifest.xml"
    text = manifest.read_text()
    app = ET.fromstring(text).find("application")
    icon = app.attrib[f"{{{ANDROID}}}icon"]
    assert icon in ["@mipmap/ic_launcher", "${appIcon}"], "Unexpected launcher binding"
    round_icon = "${appIcon}" if icon == "${appIcon}" else "@mipmap/ic_launcher_round"
    if f"{{{ANDROID}}}roundIcon" in app.attrib:
        text = re.sub(r'android:roundIcon="[^"]*"', f'android:roundIcon="{round_icon}"', text, count=1)
    else:
        text = text.replace(f'android:icon="{icon}"', f'android:icon="{icon}"\n        android:roundIcon="{round_icon}"', 1)
    write(manifest, text.encode())
    print("Android launcher: canonical OneTHU logo synced at all densities, including adaptive/round icons")


def rgba(path):
    return subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path),
                                    "-f", "rawvideo", "-pix_fmt", "rgba", "-threads", "1", "-"])


def verify(apk, source, aapt2):
    resources = subprocess.check_output([str(aapt2), "dump", "resources", str(apk)], text=True, encoding="utf-8", errors="replace")
    blocks = {}
    for match in re.finditer(r"resource (0x[0-9a-f]+) ([\w/]+)\n(.*?)(?=\n\s*resource |\Z)", resources, re.S):
        blocks[match[2]] = (match[1], match[3])
    manifest = subprocess.check_output([str(aapt2), "dump", "xmltree", "--file", "AndroidManifest.xml", str(apk)], text=True, encoding="utf-8", errors="replace")
    for attribute, name in [("icon", "ic_launcher"), ("roundIcon", "ic_launcher_round")]:
        assert re.search(rf"android:{attribute}\([^)]*\)=@{blocks['mipmap/' + name][0]}\b", manifest), "APK launcher does not reference the verified logo"
    checked = 0
    with zipfile.ZipFile(apk) as archive, tempfile.TemporaryDirectory() as directory:
        assert archive.testzip() is None
        actual = pathlib.Path(directory) / "actual.png"
        expected = pathlib.Path(directory) / "expected.png"
        for name in ["ic_launcher", "ic_launcher_round", "ic_launcher_foreground"]:
            body = blocks["mipmap/" + name][1]
            for density, size in DENSITIES.items():
                match = re.search(rf"\({density}(?:-v\d+)?\) \(file\) (\S+\.png) type=PNG", body)
                assert match, f"APK missing {name}/{density}"
                actual.write_bytes(archive.read(match[1]))
                render(source, expected, size * 108 // 48 if name.endswith("foreground") else size)
                assert rgba(actual) == rgba(expected), f"APK logo mismatch: {name}/{density}"
                checked += 1
            if name.endswith("foreground"):
                continue
            adaptive = re.search(r"\(anydpi-v26\) \(file\) (\S+\.xml) type=XML", body)
            assert adaptive, f"APK missing adaptive {name}"
            tree = subprocess.check_output([str(aapt2), "dump", "xmltree", "--file", adaptive[1], str(apk)], text=True, encoding="utf-8", errors="replace")
            assert "adaptive-icon" in tree
            assert f"@{blocks['mipmap/ic_launcher_foreground'][0]}" in tree
            assert f"@{blocks['color/onethu_launcher_background'][0]}" in tree
    print(f"APK logo verified: {checked} compiled PNGs match canonical pixels; launcher, round and adaptive bindings verified")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", nargs="?", type=pathlib.Path)
    parser.add_argument("--repo", type=pathlib.Path, default=pathlib.Path(__file__).resolve().parent.parent)
    parser.add_argument("--verify-apk", type=pathlib.Path)
    parser.add_argument("--aapt2", type=pathlib.Path)
    args = parser.parse_args()
    source = args.repo / "apps/desktop/src-tauri/icons/icon.png"
    assert source.is_file(), "Canonical logo missing"
    if args.verify_apk:
        assert args.aapt2, "--aapt2 is required for APK verification"
        verify(args.verify_apk, source, args.aapt2)
    else:
        assert args.project, "Android project path is required"
        sync(args.project.resolve(), source)


if __name__ == "__main__":
    main()
