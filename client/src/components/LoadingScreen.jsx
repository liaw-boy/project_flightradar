import React from 'react';
import './LoadingScreen.css';

export default function LoadingScreen({ visible }) {
    if (!visible) return null;

    return (
        <div className="loading-overlay">
            <div className="loader-spinner" />
            <div className="loading-text">INITIALIZING RADAR SYSTEM...</div>
        </div>
    );
}
