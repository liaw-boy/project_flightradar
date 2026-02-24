import React, { useState, useEffect } from 'react';
import './Dashboard.css';

export default function Dashboard({ planeCount, apiStatus, apiStatusClass }) {
    const [time, setTime] = useState('--:--:--');
    const [fps, setFps] = useState('--');
    const [isOnline, setIsOnline] = useState(true);

    // 系統時鐘
    useEffect(() => {
        const interval = setInterval(() => {
            setTime(new Date().toLocaleTimeString('en-US', { hour12: false }));
        }, 1000);
        return () => clearInterval(interval);
    }, []);

    // FPS 計算
    useEffect(() => {
        let frameCount = 0;
        let lastTime = performance.now();
        let animId;

        function countFrames() {
            frameCount++;
            const now = performance.now();
            if (now - lastTime >= 1000) {
                setFps(frameCount);
                frameCount = 0;
                lastTime = now;
            }
            animId = requestAnimationFrame(countFrames);
        }
        animId = requestAnimationFrame(countFrames);
        return () => cancelAnimationFrame(animId);
    }, []);

    // 根據 API 狀態設定連線指示燈
    useEffect(() => {
        setIsOnline(apiStatus !== 'ERROR');
    }, [apiStatus]);

    return (
        <div className="dashboard">
            <div className="title-container">
                <div className={`live-dot ${isOnline ? '' : 'offline'}`} />
                <h2>RADAR SYSTEM</h2>
            </div>
            <div className="stat-row">
                <span>SYS.TIME</span>
                <span className="stat-value">{time}</span>
            </div>
            <div className="stat-row">
                <span>AIRCRAFT</span>
                <span className="stat-value">{String(planeCount).padStart(3, '0')}</span>
            </div>
            <div className="stat-row">
                <span>API STATUS</span>
                <span className={`stat-value ${apiStatusClass}`}>{apiStatus}</span>
            </div>
            <div className="stat-row">
                <span>FPS</span>
                <span className="stat-value">{fps}</span>
            </div>
        </div>
    );
}
