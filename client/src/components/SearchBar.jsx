import React, { useState, useRef, useCallback } from 'react';
import { useI18n } from '../hooks/useI18n';
import './SearchBar.css';

export default function SearchBar({ planesDict, onSelectPlane }) {
    const [query, setQuery] = useState('');
    const [results, setResults] = useState([]);
    const [activeIdx, setActiveIdx] = useState(-1);
    const { t } = useI18n();
    const inputRef = useRef(null);

    const doSearch = useCallback((value) => {
        const q = value.toUpperCase().trim();
        if (q.length < 2) { setResults([]); return; }

        const matches = [];
        for (const id in planesDict) {
            const plane = planesDict[id];
            if (
                (plane.callsign && plane.callsign.includes(q)) ||
                id.toUpperCase().includes(q) ||
                (plane.registration && plane.registration.toUpperCase().includes(q)) ||
                (plane.aircraftType && plane.aircraftType.toUpperCase().includes(q))
            ) {
                matches.push({ id, plane });
                if (matches.length >= 8) break;
            }
        }
        setResults(matches);
        setActiveIdx(-1);
    }, [planesDict]);

    const handleChange = (e) => {
        const value = e.target.value;
        setQuery(value);
        doSearch(value);
    };

    const handleSelect = (id, plane) => {
        onSelectPlane(id, plane);
        setQuery(plane.callsign || id);
        setResults([]);
    };

    const handleKeyDown = (e) => {
        if (e.key === 'ArrowDown') {
            setActiveIdx(i => Math.min(i + 1, results.length - 1));
        } else if (e.key === 'ArrowUp') {
            setActiveIdx(i => Math.max(i - 1, 0));
        } else if (e.key === 'Enter') {
            if (activeIdx >= 0 && results[activeIdx]) {
                handleSelect(results[activeIdx].id, results[activeIdx].plane);
            } else if (results.length > 0) {
                handleSelect(results[0].id, results[0].plane);
            }
        } else if (e.key === 'Escape') {
            setResults([]);
        }
    };

    const handleBlur = () => {
        // Delay to allow click on dropdown to fire first
        setTimeout(() => setResults([]), 150);
    };

    return (
        <div className="search-container" style={{ position: 'relative' }}>
            <input
                ref={inputRef}
                type="text"
                className="search-box"
                placeholder={t('searchPlaceholder')}
                value={query}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
                onBlur={handleBlur}
                autoComplete="off"
            />
            {results.length > 0 && (
                <div className="search-dropdown">
                    {results.map(({ id, plane }, idx) => (
                        <div
                            key={id}
                            className={`search-result-item ${idx === activeIdx ? 'active' : ''}`}
                            onMouseDown={() => handleSelect(id, plane)}
                        >
                            <span className="sr-callsign">{plane.callsign || id.toUpperCase()}</span>
                            <span className="sr-meta">
                                {plane.aircraftType && <span className="sr-type">{plane.aircraftType}</span>}
                                {plane.registration && <span className="sr-reg">{plane.registration}</span>}
                                {plane.onGround
                                    ? <span className="sr-ground">GND</span>
                                    : <span className="sr-alt">{plane.altitude ? `${Math.round(plane.altitude / 100) * 100}m` : ''}</span>
                                }
                            </span>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
