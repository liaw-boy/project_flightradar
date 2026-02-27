/**
 * 將前端操作或錯誤傳送到後端終端顯示
 */
export const logToServer = async (message, type = 'info', data = {}) => {
    try {
        // 同時輸出到瀏覽器控制台
        if (type === 'error') console.error(`[SERVER LOG ERROR] ${message}`, data);
        else if (type === 'warn') console.warn(`[SERVER LOG WARN] ${message}`, data);
        else console.log(`[SERVER LOG] ${message}`, data);

        await fetch('/api/log', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, type, data })
        });
    } catch (e) {
        // Ignore logging errors to prevent loops
    }
};
