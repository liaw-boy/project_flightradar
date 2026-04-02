import { useState, useCallback } from 'react';

let notificationId = 0;

/**
 * Toast 通知系統 Hook
 */
export function useNotification() {
    const [notifications, setNotifications] = useState([]);

    const showNotification = useCallback((message, type = 'info') => {
        const id = ++notificationId;
        setNotifications((prev) => [...prev, { id, message, type }]);

        setTimeout(() => {
            setNotifications((prev) => prev.filter((n) => n.id !== id));
        }, 3000);
    }, []);

    const removeNotification = useCallback((id) => {
        setNotifications((prev) => prev.filter((n) => n.id !== id));
    }, []);

    return { notifications, showNotification, removeNotification };
}
