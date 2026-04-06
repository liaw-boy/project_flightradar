import React, { useEffect, useState } from 'react';
import './Dashboard.css';

export default function Dashboard({
    apiStatus,
    apiStatusClass,
    apiErrorDetail,
}) {
    const [isOnline, setIsOnline] = useState(true);

    useEffect(() => {
        setIsOnline(apiStatus !== 'ERROR' && apiStatus !== 'INIT');
    }, [apiStatus]);

    if (!apiErrorDetail) return null;

    return (
        <div className="dashboard">
            <div style={{ marginBottom: '10px', fontSize: '11px', color: '#ff4136', wordBreak: 'break-all', border: '1px solid rgba(255,65,54,0.3)', padding: '6px', borderRadius: '4px', background: 'rgba(255,65,54,0.1)' }}>
                {apiErrorDetail}
            </div>
        </div>
    );
}
