import React, { useState, useEffect, useRef } from 'react';
import './TimePlayer.css';

export default function TimePlayer({ trackPoints, onPlaybackChange, mode = 'floating' }) {
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTimeIndex, setCurrentTimeIndex] = useState(null);
    const timerRef = useRef(null);

    // Initial load or new track
    useEffect(() => {
        if (!trackPoints || trackPoints.length === 0) {
            setCurrentTimeIndex(null);
            onPlaybackChange(null);
            setIsPlaying(false);
            return;
        }

        // Start at the end (live position)
        setCurrentTimeIndex(trackPoints.length - 1);
        setIsPlaying(false);
        onPlaybackChange(null); // null means live
    }, [trackPoints]); // Only reset when fetching a totally new track

    // Playback loop
    useEffect(() => {
        if (isPlaying) {
            timerRef.current = setInterval(() => {
                setCurrentTimeIndex(prev => {
                    if (prev === null) return null;
                    const next = prev + 1;
                    if (next >= trackPoints.length - 1) {
                        // Reached the end (live)
                        setIsPlaying(false);
                        onPlaybackChange(null);
                        return trackPoints.length - 1;
                    }
                    // Continue playing
                    onPlaybackChange(trackPoints[next][0]); // Send UNIX timestamp
                    return next;
                });
            }, 100); // 100ms per tick (10 ticks per second) -> 10 real-time updates per second of playback. 
            // Note: If track points are 1 per second, this is 10x real-time speed.
        } else {
            if (timerRef.current) clearInterval(timerRef.current);
        }
        return () => {
            if (timerRef.current) clearInterval(timerRef.current);
        };
    }, [isPlaying, trackPoints, onPlaybackChange]);

    const handleScrub = (e) => {
        const val = parseInt(e.target.value, 10);
        setIsPlaying(false);
        setCurrentTimeIndex(val);

        if (val === trackPoints.length - 1) {
            onPlaybackChange(null); // Back to live
        } else {
            onPlaybackChange(trackPoints[val][0]); // specific time
        }
    };

    const togglePlay = () => {
        if (!trackPoints || trackPoints.length < 2) return;

        setIsPlaying(prev => {
            if (!prev) {
                // If we are at the end, restart from beginning
                if (currentTimeIndex >= trackPoints.length - 1) {
                    setCurrentTimeIndex(0);
                    onPlaybackChange(trackPoints[0][0]);
                }
            }
            return !prev;
        });
    };

    if (!trackPoints || trackPoints.length < 2) return null;

    const startUnix = trackPoints[0][0];
    const endUnix = trackPoints[trackPoints.length - 1][0];
    const liveUnix = Math.floor(Date.now() / 1000);

    let displayTime = '';
    let displayInfo = '';
    if (currentTimeIndex !== null && trackPoints[currentTimeIndex]) {
        const pt = trackPoints[currentTimeIndex];
        const date = new Date(pt[0] * 1000);
        displayTime = date.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });

        const alt = pt[3] !== undefined && pt[3] !== null && pt[3] !== 'GROUND' ? Math.round(pt[3]) + 'm' : 'GND';
        const spd = pt[5] !== undefined && pt[5] !== null ? Math.round(pt[5] * 3.6) + 'km/h' : (pt[4] ? '' : ''); // Fallback
        displayInfo = `${alt} • ${spd}`;
    }

    const isLive = currentTimeIndex >= trackPoints.length - 1;

    return (
        <div className={`time-player-container ${mode}`}>
            <div className="tp-header">
                <span className="tp-status">{isLive ? '🔴 LIVE' : '🕒 PLAYBACK'}</span>
                <span className="tp-time">{displayTime}</span>
                <span className="tp-info">{displayInfo}</span>
            </div>
            <div className="tp-controls">
                <button className="tp-play-btn" onClick={togglePlay}>
                    {isPlaying ? '⏸' : '▶'}
                </button>
                <input
                    type="range"
                    className={`tp-slider ${isLive ? 'live' : ''}`}
                    min={0}
                    max={trackPoints.length - 1}
                    value={currentTimeIndex || 0}
                    onChange={handleScrub}
                />
            </div>
        </div>
    );
}
