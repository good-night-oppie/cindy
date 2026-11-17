/**
 * AgyMark —— Antigravity(agy)引擎的身份 mark。
 *
 * 上游没有可用的品牌 glyph,仓库里此前对 agy 一律用中性的 `Cpu` 图标
 * (sidebar/VendorIcon.tsx)。这里给出一个同样中性的细描边形状(向上的
 * 反重力箭头),视觉重量与 ClaudeMark / CodexMark / PiMark 对齐,避免在
 * 引擎下拉里出现「一个有图标、一个是通用 CPU」的错位。
 *  - variant="mono"(默认):currentColor,跟随主题/状态染色;
 *  - variant="brand":agy 无官方品牌色,当前与 mono 相同(保留参数是为了与
 *    其它 mark 的调用面一致,出现官方色后只改这里)。
 */

interface AgyMarkProps {
  size?: number;
  className?: string;
  variant?: 'mono' | 'brand';
}

export function AgyMark({ size = 14, className }: AgyMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden
      data-ink-icon=""
    >
      <g
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M12 4.5 5.5 19.5" />
        <path d="M12 4.5 18.5 19.5" />
        <path d="M8.1 14.2h7.8" />
      </g>
    </svg>
  );
}
