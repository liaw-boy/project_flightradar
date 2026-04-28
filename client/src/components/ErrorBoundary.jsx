import React from 'react';

/**
 * Catches render errors in a subtree so they don't take down the whole map.
 * Usage: <ErrorBoundary fallback={<p>Oops</p>}><Sidebar … /></ErrorBoundary>
 */
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false };
    }

    static getDerivedStateFromError() {
        return { hasError: true };
    }

    componentDidCatch(error, info) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) return this.props.fallback;
            return (
                <div style={{
                    padding: '1rem',
                    background: 'var(--surface-2, #1a1a2e)',
                    color: 'var(--color-text, #e0e0e0)',
                    borderRadius: '8px',
                    fontSize: '0.85rem',
                }}>
                    <strong>Something went wrong.</strong>{' '}
                    <button
                        onClick={() => this.setState({ hasError: false })}
                        style={{ marginLeft: '0.5rem', cursor: 'pointer' }}
                    >
                        Retry
                    </button>
                </div>
            );
        }
        return this.props.children;
    }
}
