import { useOneGUILocale } from "../locale.js";
/* OneGUI · 小件：Icon / Chip / Tag / Badge / Divider 的 TS 侧 */
import type { ReactNode } from "react";
import { cx, one, scopeProps, type OGSize, type OGTone, type OneBase } from "./kit.js";

/* ── 图标 ───────────────────────────────────────────────────────────── */

export type IconSize = "sm" | "md" | "lg" | "xl";

export interface IconProps {
  size?: IconSize;
  /** 尺寸/描边由 CSS 决定（跟随密度与令牌），这里只放图形孩子 */
  children: ReactNode;
  className?: string;
  /** 有语义时给标题；纯装饰留空（aria-hidden） */
  title?: string;
  viewBox?: string;
}

/**
 * 图标壳：统一 24 画布、currentColor、圆头描边。
 * 具体图形在 icons.tsx（自绘线性图标集），页面不许自己写 <svg>。
 */
export function Icon({ size = "md", children, className, title, viewBox = "0 0 24 24" }: IconProps): ReactNode {
  return (
    <svg
      className={cx("og-icon", size !== "md" ? `og-icon--${size}` : "", className)}
      viewBox={viewBox}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  );
}

/* ── 胶囊/标签/角标 ─────────────────────────────────────────────────── */

export interface ChipProps extends OneBase {
  tone?: OGTone | "neutral";
  size?: OGSize;
  icon?: ReactNode;
  /** 可点（筛选条、快速入口） */
  onClick?: (e: React.MouseEvent<HTMLElement>) => void;
  selected?: boolean;
  disabled?: boolean;
  /** 可删除（显示 ×） */
  onRemove?: () => void;
  children?: ReactNode;
}

/** 胶囊：筛选、标签、快速入口共用（高度与圆角走 --r-pill 家族） */
export function Chip({ tone = "neutral", size = "md", icon, onClick, selected, disabled, onRemove, scope, className, titleAttr, "aria-label": ariaLabel, children }: ChipProps): ReactNode {
  const { t: guiText } = useOneGUILocale();
  const cls = cx(
    one("chip").size(size).tone(tone === "neutral" ? undefined : tone).state("selected", selected).state("disabled", disabled).toString(),
    onClick ? "og-chip--interactive og-interactive" : "",
    className,
  );
  const label = <>
    {icon ? <span className="og-chip-icon" aria-hidden="true">{icon}</span> : null}
    <span className="og-chip-label">{children}</span>
  </>;
  // Interactive chips are real buttons: keyboard, focus and disabled behavior
  // come from the browser. Removable chips use sibling buttons, never nesting.
  // OneBase 的 titleAttr / aria-label 必须真的到 DOM：日程全天行的 +N 只有「+3」两个字，
  // 无障碍名全靠 aria-label；此前 Chip 声明了这两个属性却把它们丢掉。
  if (onClick && !onRemove) return (
    <button type="button" {...scopeProps(scope)} className={cls} onClick={onClick} disabled={disabled} aria-pressed={selected} title={titleAttr} aria-label={ariaLabel}>
      {label}
    </button>
  );
  return (
    <span {...scopeProps(scope)} className={cls} aria-disabled={disabled || undefined} title={titleAttr} aria-label={ariaLabel}>
      {onClick ? <button type="button" className="og-chip-main og-interactive" onClick={onClick} disabled={disabled} aria-pressed={selected} title={titleAttr} aria-label={ariaLabel}>{label}</button> : label}
      {onRemove ? (
        <button type="button" className="og-chip-x" aria-label={guiText("gui.action.remove")} disabled={disabled} onClick={(e) => { e.stopPropagation(); onRemove(); }}>×</button>
      ) : null}
    </span>
  );
}

/** 只读标签（不可点、无状态层） */
export function Tag({ tone = "neutral", children, scope, className }: { tone?: ChipProps["tone"]; children: ReactNode; scope?: string; className?: string }): ReactNode {
  return (
    <span {...scopeProps(scope)} className={cx(one("tag").tone(tone === "neutral" ? undefined : tone).toString(), className)}>
      {children}
    </span>
  );
}

export interface BadgeProps {
  /** 数字角标（0 时不显示） */
  count?: number;
  /** 圆点角标 */
  dot?: boolean;
  tone?: "accent" | "error" | "warning" | "success" | "info";
  /** 角标相对宿主的位置（有宿主时用绝对定位） */
  standalone?: boolean;
  children?: ReactNode;
  className?: string;
}

export function Badge({ count, dot, tone = "accent", standalone, children, className }: BadgeProps): ReactNode {
  const show = dot || (count ?? 0) > 0;
  const badge = show ? (
    <span className={cx(one("badge").tone(tone).variant(dot ? "dot" : "count").toString(), className)}>
      {dot ? null : (count ?? 0) > 99 ? "99+" : count}
    </span>
  ) : null;
  if (standalone || !children) return badge;
  return (
    <span className="og-badge-host">
      {children}
      {badge}
    </span>
  );
}
