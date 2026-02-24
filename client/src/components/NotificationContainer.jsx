import React from 'react';
import './NotificationContainer.css';

export default function NotificationContainer({ notifications }) {
    return (
        <div className="notification-container">
            {notifications.map((n) => (
                <div key={n.id} className={`notification ${n.type}`}>
                    {n.message}
                </div>
            ))}
        </div>
    );
}
