import React from 'react';
import { AlertTriangle, X } from 'lucide-react';

export default function ConfirmDialog({ title, message, variant = 'danger', confirmLabel = '確認', onConfirm, onCancel }) {
    return (
        <div className="adm-dialog-backdrop" onClick={onCancel}>
            <div className="adm-dialog" onClick={e => e.stopPropagation()}>
                <div className={`adm-dialog-icon adm-dialog-icon--${variant}`}>
                    <AlertTriangle size={22} />
                </div>
                <h3 className="adm-dialog-title">{title}</h3>
                <p className="adm-dialog-msg">{message}</p>
                <div className="adm-dialog-actions">
                    <button className="adm-dialog-cancel" onClick={onCancel}>取消</button>
                    <button className={`adm-dialog-confirm adm-dialog-confirm--${variant}`} onClick={onConfirm}>
                        {confirmLabel}
                    </button>
                </div>
                <button className="adm-dialog-close" onClick={onCancel}><X size={14} /></button>
            </div>
        </div>
    );
}
