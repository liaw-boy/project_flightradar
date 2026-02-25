import React, { useState } from 'react';
import { useI18n } from '../hooks/useI18n';
import './SearchBar.css';

export default function SearchBar({ planesDict, onSelectPlane }) {
    const [query, setQuery] = useState('');
    const { t } = useI18n();

    const handleSearch = (e) => {
        const value = e.target.value;
        setQuery(value);

        const q = value.toUpperCase().trim();
        if (q.length < 2) return;

        for (const id in planesDict) {
            const plane = planesDict[id];
            if (plane.callsign.includes(q) || id.toUpperCase().includes(q)) {
                onSelectPlane(id, plane);
                return;
            }
        }
    };

    const handleKeyDown = (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            handleSearch({ target: { value: query } });
        }
    };

    return (
        <div className="search-container">
            <input
                type="text"
                className="search-box"
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={handleSearch}
                onKeyDown={handleKeyDown}
                autoComplete="off"
            />
        </div>
    );
}
