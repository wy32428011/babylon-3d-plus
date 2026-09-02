type FullscreenGlyphProps = {
  /** true 时绘制四角向内的退出图标，否则绘制四角向外的进入图标。 */
  exit?: boolean;
};

/** Toolbar / Viewer 共用的全屏图标，描边跟随 currentColor。 */
export function FullscreenGlyph({ exit = false }: FullscreenGlyphProps) {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 16 16">
      {exit ? (
        <path
          d="M2 6h4V2M10 2v4h4M2 10h4v4M10 14v-4h4"
          stroke="currentColor"
          strokeLinecap="square"
          strokeWidth="1.6"
        />
      ) : (
        <path
          d="M6 2H2v4M10 2h4v4M2 10v4h4M14 10v4h-4"
          stroke="currentColor"
          strokeLinecap="square"
          strokeWidth="1.6"
        />
      )}
    </svg>
  );
}
