import React, { useEffect } from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import './ConfirmDialog.css';

export default function ConfirmDialog({ title, message, variant = 'danger', confirmLabel = '確認', onConfirm, onCancel }) {
    useEffect(() => {
        const onKeyDown = (e) => { if (e.key === 'Escape') onCancel(); };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [onCancel]);

    return ReactDOM.createPortal(
        <div className="confirm-dialog-backdrop" onClick={onCancel}>
            <div className="confirm-dialog-box" role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title" onClick={e => e.stopPropagation()}>
                <button className="confirm-dialog-close" onClick={onCancel}><X size={14} /></button>
                <div className={`confirm-dialog-icon confirm-dialog-icon--${variant}`}>
                    <AlertTriangle size={22} />
                </div>
                <h3 id="confirm-dialog-title" className="confirm-dialog-title">{title}</h3>
                <p className="confirm-dialog-msg">{message}</p>
                <div className="confirm-dialog-actions">
                    <button className="confirm-dialog-cancel" onClick={onCancel}>取消</button>
                    <button className={`confirm-dialog-confirm confirm-dialog-confirm--${variant}`} onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
}
