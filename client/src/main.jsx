import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider } from './hooks/useI18n';
import './index.css';

class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { hasError: false, error: null, errorInfo: null };
    }
    static getDerivedStateFromError(error) {
        return { hasError: true };
    }
    componentDidCatch(error, errorInfo) {
        this.setState({ error, errorInfo });
    }
    render() {
        if (this.state.hasError) {
            return (
                <div style={{ color: 'white', padding: '20px', background: '#900', height: '100vh', width: '100vw', zIndex: 99999, position: 'absolute', top: 0, left: 0 }}>
                    <h1 style={{ color: 'white' }}>Something went wrong.</h1>
                    <pre style={{ whiteSpace: 'pre-wrap', color: '#ffb' }}>{this.state.error && this.state.error.toString()}</pre>
                    <pre style={{ whiteSpace: 'pre-wrap', color: '#aaa' }}>{this.state.errorInfo && this.state.errorInfo.componentStack}</pre>
                </div>
            );
        }
        return this.props.children;
    }
}

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <I18nProvider>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </I18nProvider>
    </React.StrictMode>
);
