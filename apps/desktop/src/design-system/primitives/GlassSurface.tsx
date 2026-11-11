import type { ElementType, HTMLAttributes, ReactNode } from "react";

export type GlassVariant = "regular" | "elevated" | "clear";

export interface GlassSurfaceProps extends HTMLAttributes<HTMLElement> {
  /** regular = 导航/工具条；elevated = 菜单/弹窗；clear = 仅高对比背景上的浮动控件 */
  variant?: GlassVariant;
  as?: ElementType;
  children?: ReactNode;
}

/** 统一玻璃材质外壳：模糊、边框、阴影与顶部高光只在这里定义 */
export function GlassSurface({
  variant = "regular",
  as: Tag = "div",
  className,
  children,
  ...rest
}: GlassSurfaceProps) {
  const classes = [
    "glass-surface",
    variant === "elevated" ? "glass-surface--elevated" : "",
    variant === "clear" ? "glass-surface--clear" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <Tag className={classes} {...rest}>
      {children}
    </Tag>
  );
}
