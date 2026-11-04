// Brand mark — an open book whose top page physically turns.
//
// Two layers, pixel-aligned (same 24×24 viewBox, both fill the badge):
//   1. a STATIC open book — left page + right page + spine.
//   2. a TURNING sheet — a duplicate of the right page in its own <svg>.
//
// The turning sheet rotates rotateY(0 → -90° → -180°) around the spine (the
// SVG's vertical centre). Its wrapper carries the `perspective`, so as the page
// lifts it foreshortens — top AND bottom edges sweep through an arc, a real 3D
// flip rather than a flat horizontal squash. It gets its own <svg> on purpose:
// 3D transforms are reliable on a replaced element (the <svg> box) but flaky on
// an inner SVG <path>. Because the left page is the exact mirror of the right,
// the sheet coincides with a static page at rotateY(0) and rotateY(-180°) — so
// the animation loop's reset is invisible; it only reads as a distinct sheet
// mid-turn. Keyframes + reduced-motion guard live in index.css (.tm-book-page).
const RIGHT_PAGE = "M12 6.2C14.5 5.2 18 5 20.5 5.4L20.5 16.8C18 16.4 14.5 16.6 12 18Z";
const LEFT_PAGE = "M12 6.2C9.5 5.2 6 5 3.5 5.4L3.5 16.8C6 16.4 9.5 16.6 12 18Z";

const SVG_PROPS = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function BookFlipIcon({ className }: { className?: string }) {
  return (
    <span className={`relative inline-block ${className ?? ""}`} aria-hidden="true">
      {/* static open book */}
      <svg {...SVG_PROPS} className="absolute inset-0 h-full w-full">
        <path d={LEFT_PAGE} />
        <path d={RIGHT_PAGE} />
        <path d="M12 6.2V18" />
      </svg>
      {/* turning sheet — perspective on the wrapper, rotateY on the svg */}
      <span className="absolute inset-0 [perspective:64px]">
        <svg {...SVG_PROPS} className="tm-book-page h-full w-full">
          <path d={RIGHT_PAGE} />
        </svg>
      </span>
    </span>
  );
}
