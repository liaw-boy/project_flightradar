/**
 * storageManager.js - AERO-SYNC 雙層快取管理員 (LRU + IndexedDB)
 */

// --- [L2] LRU Cache with TTL Implementation ---
export class LRUCache {
    constructor(capacity = 500, ttlMs = 1800000) { // 預設 500 筆, 30 分鐘
        this.capacity = capacity;
        this.ttl = ttlMs;
        this.cache = new Map();
    }

    get(key) {
        if (!this.cache.has(key)) return null;

        const entry = this.cache.get(key);
        // 檢查是否過期
        if (Date.now() > entry.expiry) {
            this.cache.delete(key);
            return null;
        }

        // 刷新位置 (LRU: 把最常用的放在後面)
        this.cache.delete(key);
        this.cache.set(key, entry);
        return entry.value;
    }

    put(key, value) {
        if (this.cache.has(key)) {
            this.cache.delete(key);
        } else if (this.cache.size >= this.capacity) {
            // 刪除第一個 (最舊的)
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            value,
            expiry: Date.now() + this.ttl
        });
    }

    clear() {
        this.cache.clear();
    }
}

// --- [L3] IndexedDB Persistent Storage ---
const DB_NAME = 'AeroSyncDB';
const DB_VERSION = 1;

export class IndexedDBManager {
    constructor() {
        this.db = null;
    }

    async init() {
        if (this.db) return this.db;

        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('airports')) {
                    db.createObjectStore('airports', { keyPath: 'icao' });
                }
                if (!db.objectStoreNames.contains('metadata')) {
                    db.createObjectStore('metadata', { keyPath: 'key' });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                resolve(this.db);
            };

            request.onerror = (event) => {
                reject('IndexedDB error: ' + event.target.errorCode);
            };
        });
    }

    async get(storeName, key) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.get(key);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async getAll(storeName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readonly');
            const store = transaction.objectStore(storeName);
            const request = store.getAll();

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async put(storeName, value) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.put(value);

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async putAll(storeName, values) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);

            values.forEach(val => store.put(val));

            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
        });
    }

    async clear(storeName) {
        const db = await this.init();
        return new Promise((resolve, reject) => {
            const transaction = db.transaction(storeName, 'readwrite');
            const store = transaction.objectStore(storeName);
            const request = store.clear();

            request.onsuccess = () => resolve();
            request.onerror = () => reject(request.error);
        });
    }
}

// 實例化全域單例
export const idb = new IndexedDBManager();
export const lruCache = new LRUCache();
