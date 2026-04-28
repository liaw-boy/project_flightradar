export default function AeroIcon({ size = 24, bg = true, className = '', color, style }) {
    const radius = Math.round(size * 0.19);
    const baseStyle = {
        display: 'block',
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        filter: 'drop-shadow(0 0 2px rgba(255,255,255,0.9)) drop-shadow(0 0 1px rgba(255,255,255,0.6)) brightness(1.25) saturate(0.85) hue-rotate(-15deg) drop-shadow(0 2px 5px rgba(0,0,0,0.8))',
    };
    return (
        <img
            src="/airplane-icon.png?v=20260428g"
            width={size}
            height={size}
            className={className}
            aria-hidden="true"
            alt=""
            style={{ ...baseStyle, ...style }}
        />
    );
}
