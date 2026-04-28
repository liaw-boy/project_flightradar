export default function AeroIcon({ size = 24, bg = true, className = '', color, style }) {
    const radius = Math.round(size * 0.19);
    const baseStyle = {
        display: 'block',
        width: size,
        height: size,
        borderRadius: radius,
        flexShrink: 0,
        filter: 'drop-shadow(0 2px 4px rgba(0,0,0,0.7)) drop-shadow(0 1px 1px rgba(0,0,0,0.5))',
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
