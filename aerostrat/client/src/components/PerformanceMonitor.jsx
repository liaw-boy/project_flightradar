import React, { useState, useEffect, useRef } from 'react';
import { Activity, Layers, Zap } from 'lucide-react';
import './PerformanceMonitor.css';

export default function PerformanceMonitor({ usageStats }) {
    const [fps, setFps] = useState(60);
    const [fpsHistory, setFpsHistory] = useState([]);
    const frameCount = useRef(0);
    const lastTime = useRef(performance.now());
    const reqRef = useRef(null);

    useEffect(() => {
        const calculateFps = () => {
            const now = performance.now();
            const delta = now - lastTime.current;
            frameCount.current++;

            if (delta >= 1000) {
                const currentFps = Math.round((frameCount.current * 1000) / delta);
                setFps(currentFps);
                setFpsHistory(prev => {
                    const next = [...prev, currentFps];
                    return next.length > 20 ? next.slice(1) : next;
                });
                frameCount.current = 0;
                lastTime.current = now;
            }
            reqRef.current = requestAnimationFrame(calculateFps);
        };

        reqRef.current = requestAnimationFrame(calculateFps);
        return () => cancelAnimationFrame(reqRef.current);
    }, []);

    // Calculate sparkline SVG path
    const sparklinePath = fpsHistory.length > 1
        ? `M 0,${20 - (fpsHistory[0] / 60) * 20} ` + fpsHistory.map((val, i) =>
            `L ${(i / (fpsHistory.length - 1)) * 40},${20 - Math.min(1, val / 60) * 20}`
        ).join(' ')
        : '';

    return (
        <div className="perf-monitor-container">
            <div className="perf-header">
                <Zap size={14} className={fps >= 55 ? 'color-good' : fps >= 30 ? 'color-warn' : 'color-critical'} />
                <span>AERO-SYNC ENGINE</span>
            </div>

            <div className="perf-grid">
                <div className="perf-metric">
                    <div className="perf-val-row">
                        <span className={`perf-val ${fps >= 55 ? 'color-good' : fps >= 30 ? 'color-warn' : 'color-critical'}`}>
                            {fps}
                        </span>
                        <span className="perf-unit">FPS</span>
                    </div>
                    {sparklinePath && (
                        <svg width="40" height="20" className="perf-sparkline">
                            <path d={sparklinePath} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    )}
                </div>

                <div className="perf-divider" />

                <div className="perf-metric">
                    <span className="perf-label"><Layers size={10} /> RENDERED</span>
                    <span className="perf-number">{usageStats?.visibleCount?.toLocaleString() || 0}</span>
                </div>

                <div className="perf-divider" />

                <div className="perf-metric">
                    <span className="perf-label"><Activity size={10} /> IN VIEW</span>
                    <span className="perf-number">{usageStats?.totalInView?.toLocaleString() || 0}</span>
                </div>
            </div>
            {usageStats?.throttleFactor < 1.0 && (
                <div className="perf-throttle-warn">
                    Dynamic Throttle Active ({usageStats.throttleFactor.toFixed(2)}x)
                </div>
            )}
        </div>
    );
}
