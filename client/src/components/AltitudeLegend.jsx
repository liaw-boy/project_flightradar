import React from 'react';

// Shows the tar1090 HSL gradient with altitude labels, matching the track colors.
// Only visible in ALTITUDE scheme; hidden in TACTICAL and other solid-color modes.
export default function AltitudeLegend({ colorScheme }) {
    if (colorScheme === 'TACTICAL' || colorScheme === 'MONO') return null;

    const stops = [
        { label: 'GND',    h: 20,  s: 88, l: 52 },
        { label: '3km',    h: 140, s: 88, l: 41 },
        { label: '12km',   h: 300, s: 88, l: 48 },
        { label: '15km+',  h: 360, s: 88, l: 52 },
    ];
    const gradientColors = [
        `hsl(20,88%,52%)`,
        `hsl(54,88%,49%)`,
        `hsl(140,88%,41%)`,
        `hsl(220,88%,52%)`,
        `hsl(300,88%,48%)`,
        `hsl(360,88%,52%)`,
    ].join(', ');

    return (
        <div style={{
            position: 'absolute',
            bottom: '28px',
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 1000,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: '3px',
            pointerEvents: 'none',
        }}>
            <span style={{
                fontSize: '9px',
                fontFamily: 'JetBrains Mono, monospace',
                fontWeight: 700,
                color: 'rgba(255,255,255,0.55)',
                letterSpacing: '1.2px',
                textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                alignSelf: 'flex-start',
                paddingLeft: '2px',
            }}>ALT</span>
            <div style={{
                width: '220px',
                height: '7px',
                borderRadius: '4px',
                background: `linear-gradient(to right, ${gradientColors})`,
                boxShadow: '0 1px 6px rgba(0,0,0,0.7)',
            }} />
            <div style={{
                width: '220px',
                display: 'flex',
                justifyContent: 'space-between',
                padding: '0 2px',
            }}>
                {stops.map(({ label, h, s, l }) => (
                    <span key={label} style={{
                        fontSize: '9px',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontWeight: 700,
                        color: `hsl(${h},${s}%,${Math.min(l + 15, 80)}%)`,
                        textShadow: '0 1px 3px rgba(0,0,0,0.9)',
                        letterSpacing: '0.4px',
                    }}>{label}</span>
                ))}
            </div>
        </div>
    );
}
