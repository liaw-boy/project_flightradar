export default function AeroIcon({ size = 24, bg = true, className = '', color, style }) {
    const radius = Math.round(size * 0.19);
    if (bg) {
        return (
            <span
                className={className}
                aria-hidden="true"
                style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: size,
                    height: size,
                    borderRadius: radius,
                    overflow: 'hidden',
                    flexShrink: 0,
                    ...style,
                }}
            >
                <img src="/airplane-icon.png" width={size} height={size} alt="" style={{ display: 'block' }} />
            </span>
        );
    }
    return (
        <img
            src="/airplane-icon.png"
            width={size}
            height={size}
            className={className}
            aria-hidden="true"
            alt=""
            style={{ display: 'block', flexShrink: 0, ...style }}
        />
    );
}
