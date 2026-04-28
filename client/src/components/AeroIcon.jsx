export default function AeroIcon({ size = 24, bg = true, className = '', color, style }) {
    const radius = Math.round(size * 0.19);
    const baseStyle = {
        display: 'block',
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        filter: 'brightness(1.25) saturate(0.85) hue-rotate(-15deg) drop-shadow(0 2px 4px rgba(0,0,0,0.7))',
    };
    return (
        <img
            src="/airplane-icon.png"
            width={size}
            height={size}
            className={className}
            aria-hidden="true"
            alt=""
            style={{ ...baseStyle, ...style }}
        />
    );
}
