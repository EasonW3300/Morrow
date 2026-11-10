import type { ButtonHTMLAttributes, ReactNode } from "react";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "nav";
export type ButtonSize = "sm" | "md";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  selected?: boolean;
  loading?: boolean;
  children?: ReactNode;
}

/** 统一按钮：主操作实底、次操作描边、导航项与图标按钮为 ghost；沿用既有 .btn/.nav-item 类名 */
export function Button({
  variant = "secondary",
  size = "md",
  iconOnly = false,
  selected = false,
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  const classes =
    variant === "nav"
      ? ["nav-item", selected ? "selected" : "", className ?? ""]
      : [
          "btn",
          variant === "primary" ? "primary" : "",
          variant === "danger" ? "danger" : "",
          variant === "ghost" ? "ghost" : "",
          size === "sm" ? "sm" : "",
          iconOnly ? "icon" : "",
          className ?? "",
        ];
  return (
    <button
      type={type}
      className={classes.filter(Boolean).join(" ")}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <span className="btn-spinner" aria-hidden="true" /> : children}
    </button>
  );
}
