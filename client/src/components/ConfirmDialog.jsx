import React from 'react';
import ReactDOM from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';
import './ConfirmDialog.css';

export default function ConfirmDialog({ title, message, variant = 'danger', confirmLabel = '確認', onConfirm, onCancel }) {
    return ReactDOM.createPortal(
        <div className="confirm-dialog-backdrop" onClick={onCancel}>
            <div className="confirm-dialog-box" onClick={e => e.stopPropagation()}>
                <button className="confirm-dialog-close" onClick={onCancel}><X size={14} /></button>
                <div className={`confirm-dialog-icon confirm-dialog-icon--${variant}`}>
                    <AlertTriangle size={22} />
                </div>
                <h3 className="confirm-dialog-title">{title}</h3>
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
