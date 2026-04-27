import React from 'react';
import AeroIcon from './AeroIcon';
import './LoadingScreen.css';

export default function LoadingScreen({ visible }) {
    if (!visible) return null;

    return (
        <div className="loading-overlay">
            <AeroIcon size={48} className="loader-icon" />
            <div className="loader-spinner" />
            <div className="loading-text">INITIALIZING RADAR SYSTEM...</div>
        </div>
    );
}
