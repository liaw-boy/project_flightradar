import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { X, User, Lock, Mail, AlertCircle } from 'lucide-react';
import { apiLogin, apiRegister, authStore } from '../store/authStore';
import AeroIcon from './AeroIcon';
import './AuthModal.css';

/* ─── A380 (A388) top-view — extracted from project SVG database ─── */
function A380TopView() {
    return (
        <svg viewBox="-0.25 -4 80 80" xmlns="http://www.w3.org/2000/svg"
            className="auth-plane-svg" aria-hidden="true"
            style={{ overflow: 'visible' }}>
            <path className="plane-body"
                    d="m 39.323759,0.18838233 -1.277647,1.13170037 -1.280616,2.8325907 -0.761311,3.0697325 -0.286615,1.7948893 0.02936,10.2526718 -8.659221,7.449928 0.148914,-4.110239 -0.471561,-0.52054 -3.023888,0.04197 -0.426625,0.802456 -0.05368,3.68518 0.05715,0.999645 0.412606,0.560328 0.377975,6.59e-4 0.09317,0.756118 -7.853467,5.986674 0.287192,-2.12562 -0.13737,-2.504333 -0.376821,-0.662118 -2.929475,0.08938 -0.331472,0.424645 0.135123,5.43177 0.350033,0.293633 0.569884,-0.0067 0.468428,0.395498 -0.414677,0.360548 -12.9487314,9.663054 -0.6634364,1.132773 -0.2856257,1.227925 0.13481409,3.968991 0.33081111,-0.04667 -0.0444432,-1.606479 13.2394545,-5.882779 0.328584,1.228998 0.47247,8.25e-4 0.380944,-1.70023 2.74255,-1.270885 0.517325,1.371068 0.472551,-0.04643 0.239369,-1.794971 3.073361,-1.317555 0.47016,1.32374 0.425305,-0.04651 0.144792,-1.747892 2.884291,-1.270638 0.47082,0.945764 0.283483,4.95e-4 0.143966,-1.27542 3.07303,-1.128566 0.328832,1.087257 0.377976,6.6e-4 0.0021,-1.22842 4.632509,-1.314833 0.325451,3.024381 0.517245,1.418315 0.08014,8.221136 0.135806,3.402027 0.609015,2.977629 0.516169,2.032526 -10.455758,8.108253 -1.136896,1.69891 -0.617757,2.030547 0.09193,1.464822 13.52145,-5.031842 0.799324,2.22201 0.897693,0.0016 0.712992,-2.455604 13.598793,4.79569 -0.04428,-1.700973 -0.610996,-1.843702 -1.178453,-1.561211 -10.758366,-8.003538 0.950793,-3.352884 0.433963,-5.007434 -0.08047,-8.032146 0.477251,-1.40315 0.217673,-3.173165 4.318945,1.136028 0.328502,1.465233 0.424974,0.142482 0.144131,-1.369914 3.068911,1.233782 0.187336,0.945269 0.519306,0.23714 0.04898,-0.992104 3.210896,1.09229 0.185688,1.890206 0.377646,0.189648 0.428193,-1.700147 3.257566,1.423097 0.138606,1.795633 0.519717,9.07e-4 0.333203,-1.416833 2.974662,1.091877 0.32743,1.890453 0.519715,9.07e-4 0.191545,-1.464324 13.408155,5.740299 0.04436,1.653726 0.330811,-0.04667 -0.08649,-4.583119 -0.753229,-1.56047 -13.401644,-9.472807 0.142155,-0.235989 0.284311,-0.47197 v 0 l 0.66154,-0.0461 0.147182,-3.118053 -0.04304,-2.409675 -0.424232,-0.567707 -3.212876,0.04164 -0.190226,0.708374 0.134239,4.29972 -7.880429,-5.636159 0.09573,-0.708539 0.472388,0.04808 0.285212,-0.991692 -0.08699,-4.299636 -0.376491,-0.851105 -3.071217,0.08913 -0.190308,0.755621 0.08781,3.827168 L 43.165018,19.093912 42.899351,8.8880762 42.57184,7.0448801 41.86866,3.8780975 40.503117,1.2298768 Z"/>
                <path className="plane-accent"
                    d="m 42.228584,57.763626 -0.634763,3.474505 -0.133636,2.539059 -0.300679,2.305201 m -3.80859,-8.118314 c 0,0 0.734991,3.274052 0.801809,3.474506 0.06682,0.200451 0.200454,2.505652 0.200454,2.505652 l 0.367495,2.338607 m 4.460057,-47.156367 0.350791,21.966213 M 35.747298,19.26011 36.047976,41.393366 m 3.828513,11.098078 -0.519719,0.850444 -0.165364,3.685268 0.212611,7.488655 0.425222,6.614584 0.425226,0.02363 0.212611,-6.59096 0.118117,-7.583147 -0.141742,-3.732515 z m 24.473958,-17.221542 0.803198,0.73233 m -2.362351,-1.771764 1.535528,1.086681 -0.188989,-3.661643 0.4016,-0.566965 0.425223,0.425223 v 2.267857 l 0.236236,2.244233 m -13.134674,-9.591144 1.559153,1.393786 -0.04725,-2.976562 0.212612,-1.015811 0.236235,0.02362 0.259858,0.850446 v 1.984375 l 0.496094,1.889879 -1.181171,-0.803193 m -38.388208,8.031993 -0.803199,0.496094 m 0,-0.04725 -0.07087,-3.756139 0.307105,-0.850445 0.354353,0.590587 v 3.071056 l 0.188988,0.54334 1.181176,-0.921316 m 8.457217,-6.354725 1.015811,-0.661458 m -1.653646,1.086683 0.685082,-0.472472 -0.07087,-2.527715 0.330729,-1.984375 h 0.354353 l 0.307106,3.897879 1.299292,-1.204799 m 10.35891,-22.4777706 0.614211,-0.023625 0.04725,-0.5669643 0.389787,-0.6732701 0.543343,-0.1181177 h 0.602398 l 0.54334,0.1771764 0.366165,0.5315291 0.08268,0.626023 L 41.2939,4.1695468 41.022227,3.319101 40.467076,2.5867721 39.935546,2.1143019 H 38.730748 L 38.27009,2.5277134 37.951171,2.8938778 37.490513,3.661642 Z"/>
        </svg>
    );
}

/* ─── Barcode decoration ─── */
const BARS = [28,18,28,14,28,22,28,16,28,24,28,12,28,28,16,28,20,28,14,28,28,22,12,28,16,28,20,28,26,28,14,28,18,22,28,12,28,20,28,24,28,16,28,28,18,28,22,28,12,28,20,28,26,28,16,28,14,28,22,28,18,28,12,28,20,26,28,16,28,18,28,12,28,28,22,28,20,28,16,28];

/* ─── Google icon ─── */
function GoogleIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
            <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
            <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
            <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
            <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
        </svg>
    );
}

/* ─── Facebook icon ─── */
function FacebookIcon() {
    return (
        <svg width="18" height="18" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="#1877F2">
            <path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.236 2.686.236v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.268h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/>
        </svg>
    );
}

/* ─── Handle OAuth redirect result on page load ─── */
function useOAuthRedirect(onSuccess) {
    useEffect(() => {
        const params = new URLSearchParams(window.location.search);
        const success = params.get('oauth_success');
        const error   = params.get('oauth_error');

        if (success) {
            try {
                const { user, tokenExpiry } = JSON.parse(atob(success));
                const parsedUser = typeof user === 'string' ? JSON.parse(user) : user;
                authStore._set(parsedUser, tokenExpiry || null);
                // Clean URL
                window.history.replaceState({}, '', window.location.pathname);
                onSuccess?.();
            } catch (_) {}
        }
        if (error) {
            window.history.replaceState({}, '', window.location.pathname);
        }
    }, []);
}

/* ─── Main Component ─── */
export default function AuthModal({ onClose }) {
    const [mode, setMode]         = useState('login');
    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [email, setEmail]       = useState('');
    const [error, setError]       = useState('');
    const [loading, setLoading]   = useState(false);
    const [tearing, setTearing]   = useState(false);
    const [oauthConfig, setOauthConfig] = useState({ google: false, facebook: false });
    const inputRef  = useRef(null);
    const cardRef   = useRef(null);  // .auth-right
    const stubRef   = useRef(null);  // .auth-stub
    const tearRef   = useRef(null);  // .auth-tear
    const modalRef  = useRef(null);  // .auth-overlay — for focus trap
    const prevFocusRef = useRef(null);

    // Check which OAuth providers are configured
    useEffect(() => {
        fetch('/api/auth/config')
            .then(r => r.json())
            .then(setOauthConfig)
            .catch(() => {});
    }, []);

    useEffect(() => { inputRef.current?.focus(); }, [mode]);

    // Capture previously focused element synchronously (before autofocus moves it)
    useLayoutEffect(() => {
        prevFocusRef.current = document.activeElement;
        return () => {
            const prev = prevFocusRef.current;
            // Blur current focus first to prevent typing into background
            if (document.activeElement && document.activeElement !== document.body) {
                document.activeElement.blur();
            }
            if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
                setTimeout(() => prev.focus?.(), 0);
            }
        };
    }, []);

    // Escape + Tab focus trap
    useEffect(() => {
        const h = (e) => {
            if (e.key === 'Escape') { onClose(); return; }
            if (e.key !== 'Tab' || !modalRef.current) return;
            const focusables = modalRef.current.querySelectorAll(
                'button:not([disabled]), input:not([disabled]), a[href], select, textarea, [tabindex]:not([tabindex="-1"])'
            );
            if (!focusables.length) return;
            const first = focusables[0];
            const last  = focusables[focusables.length - 1];
            if (e.shiftKey && document.activeElement === first) {
                e.preventDefault(); last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
                e.preventDefault(); first.focus();
            }
        };
        window.addEventListener('keydown', h);
        return () => window.removeEventListener('keydown', h);
    }, [onClose]);

    useOAuthRedirect(onClose);

    async function handleSubmit(e) {
        e.preventDefault();
        setError(''); setLoading(true);
        try {
            mode === 'login'
                ? await apiLogin(username, password)
                : await apiRegister(username, password, email || undefined);
            // 撕票動畫：先撕再關
            setLoading(false);
            // 動態量測 stub 高度，精確對齊缺口
            if (cardRef.current && tearRef.current) {
                // getBoundingClientRect() 是 screen space（已含 scale 1.40）
                // clip-path: inset() 值在元素自身座標系（pre-scale），需除以 scale
                const SCALE = 1.40;
                const cardRect = cardRef.current.getBoundingClientRect();
                const tearRect = tearRef.current.getBoundingClientRect();
                const tearMid  = tearRect.top + tearRect.height / 2;
                const clipH    = Math.round((cardRect.bottom - tearMid) / SCALE);
                cardRef.current.style.setProperty('--tear-clip-h', `${clipH}px`);
            }
            setTearing(true);
            setTimeout(onClose, 2200);
        } catch (err) {
            setError(err.message);
            setLoading(false);
        }
    }

    const today = new Date().toLocaleDateString('en-GB', {
        day: '2-digit', month: 'short', year: 'numeric'
    }).toUpperCase();

    const hasOAuth = oauthConfig.google || oauthConfig.facebook;

    return (
        <div ref={modalRef} className="auth-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="auth-modal">

                {/* ══ LEFT — Plane Scene ══ */}
                <div className="auth-left">
                    {/* Runway SVG — runway-x:85% runway-y:49% scale:1.0 opacity:0.4 */}
                    <div className="auth-runway" aria-hidden="true">
                        <svg viewBox="0 0 500 900" width="500" height="900" style={{overflow:'visible',display:'block'}}>
                          <defs><style>{`
                            .rwy-fill    { fill: rgba(45,50,62,0.90); stroke: none; }
                            .twy-fill    { fill: rgba(55,62,78,0.88); stroke: none; }
                            .apron-fill  { fill: rgba(48,55,70,0.85); stroke: none; }
                            .rwy-edge    { stroke: rgba(196,162,96,0.80); stroke-width: 2;   fill: none; }
                            .rwy-mark    { stroke: rgba(255,255,255,0.90); stroke-width: 2;   fill: none; }
                            .rwy-center  { stroke: rgba(255,255,255,0.85); stroke-width: 1.5; fill: none; stroke-dasharray: 30 15; }
                            .rwy-tdz     { stroke: rgba(255,255,255,0.70); stroke-width: 1.4; fill: none; }
                            .rwy-aim     { stroke: rgba(255,255,255,0.80); stroke-width: 1.8; fill: none; }
                            .twy-edge    { stroke: rgba(196,162,96,0.85); stroke-width: 1.5; fill: none; }
                            .twy-cl      { stroke: rgba(255,210,60,0.80);  stroke-width: 1.4; fill: none; stroke-dasharray: 14 8; }
                            .apron-edge  { stroke: rgba(196,162,96,0.75); stroke-width: 1.4; fill: none; stroke-dasharray: 6 4; }
                            .hold        { stroke: rgba(255,220,50,0.90);  stroke-width: 2;   fill: none; stroke-dasharray: 8 4 2 4; }
                            .rwy-num     { font-family: 'Arial Narrow', Arial, sans-serif; font-size: 20px; font-weight: 700; fill: rgba(255,255,255,0.85); letter-spacing: 3px; text-anchor: middle; }
                          `}</style></defs>
                          <rect className="twy-fill" x="135" y="60" width="30" height="780"/>
                          <rect className="twy-fill" x="335" y="60" width="30" height="780"/>
                          <rect className="twy-fill" x="135" y="168" width="83" height="24"/>
                          <rect className="twy-fill" x="282" y="168" width="83" height="24"/>
                          <rect className="twy-fill" x="135" y="668" width="83" height="24"/>
                          <rect className="twy-fill" x="282" y="668" width="83" height="24"/>
                          <rect className="twy-fill" x="135" y="438" width="83" height="24"/>
                          <rect className="twy-fill" x="282" y="438" width="83" height="24"/>
                          <rect className="apron-fill" x="42" y="50" width="100" height="260" rx="5"/>
                          <rect className="apron-fill" x="358" y="590" width="100" height="250" rx="5"/>
                          <rect className="rwy-fill" x="218" y="60" width="64" height="780"/>
                          <line className="rwy-edge" x1="218" y1="60"  x2="218" y2="840"/>
                          <line className="rwy-edge" x1="282" y1="60"  x2="282" y2="840"/>
                          <line className="rwy-mark" x1="218" y1="60"  x2="282" y2="60"/>
                          <line className="rwy-mark" x1="218" y1="840" x2="282" y2="840"/>
                          <line className="rwy-mark" x1="221" y1="63" x2="221" y2="108"/><line className="rwy-mark" x1="225" y1="63" x2="225" y2="108"/><line className="rwy-mark" x1="229" y1="63" x2="229" y2="108"/><line className="rwy-mark" x1="233" y1="63" x2="233" y2="108"/><line className="rwy-mark" x1="237" y1="63" x2="237" y2="108"/><line className="rwy-mark" x1="241" y1="63" x2="241" y2="108"/><line className="rwy-mark" x1="245" y1="63" x2="245" y2="108"/><line className="rwy-mark" x1="249" y1="63" x2="249" y2="108"/><line className="rwy-mark" x1="253" y1="63" x2="253" y2="108"/><line className="rwy-mark" x1="257" y1="63" x2="257" y2="108"/><line className="rwy-mark" x1="261" y1="63" x2="261" y2="108"/><line className="rwy-mark" x1="265" y1="63" x2="265" y2="108"/><line className="rwy-mark" x1="269" y1="63" x2="269" y2="108"/><line className="rwy-mark" x1="273" y1="63" x2="273" y2="108"/><line className="rwy-mark" x1="277" y1="63" x2="277" y2="108"/><line className="rwy-mark" x1="281" y1="63" x2="281" y2="108"/>
                          <text className="rwy-num" x="250" y="130">18</text>
                          <line className="rwy-mark" x1="221" y1="795" x2="221" y2="838"/><line className="rwy-mark" x1="225" y1="795" x2="225" y2="838"/><line className="rwy-mark" x1="229" y1="795" x2="229" y2="838"/><line className="rwy-mark" x1="233" y1="795" x2="233" y2="838"/><line className="rwy-mark" x1="237" y1="795" x2="237" y2="838"/><line className="rwy-mark" x1="241" y1="795" x2="241" y2="838"/><line className="rwy-mark" x1="245" y1="795" x2="245" y2="838"/><line className="rwy-mark" x1="249" y1="795" x2="249" y2="838"/><line className="rwy-mark" x1="253" y1="795" x2="253" y2="838"/><line className="rwy-mark" x1="257" y1="795" x2="257" y2="838"/><line className="rwy-mark" x1="261" y1="795" x2="261" y2="838"/><line className="rwy-mark" x1="265" y1="795" x2="265" y2="838"/><line className="rwy-mark" x1="269" y1="795" x2="269" y2="838"/><line className="rwy-mark" x1="273" y1="795" x2="273" y2="838"/><line className="rwy-mark" x1="277" y1="795" x2="277" y2="838"/><line className="rwy-mark" x1="281" y1="795" x2="281" y2="838"/>
                          <text className="rwy-num" x="250" y="790">36</text>
                          <line className="rwy-center" x1="250" y1="148" x2="250" y2="762"/>
                          <line className="rwy-aim" x1="224" y1="178" x2="224" y2="234"/><line className="rwy-aim" x1="230" y1="178" x2="230" y2="234"/><line className="rwy-aim" x1="270" y1="178" x2="270" y2="234"/><line className="rwy-aim" x1="276" y1="178" x2="276" y2="234"/>
                          <line className="rwy-aim" x1="224" y1="666" x2="224" y2="722"/><line className="rwy-aim" x1="230" y1="666" x2="230" y2="722"/><line className="rwy-aim" x1="270" y1="666" x2="270" y2="722"/><line className="rwy-aim" x1="276" y1="666" x2="276" y2="722"/>
                          <line className="rwy-tdz" x1="223" y1="140" x2="223" y2="158"/><line className="rwy-tdz" x1="229" y1="140" x2="229" y2="158"/><line className="rwy-tdz" x1="271" y1="140" x2="271" y2="158"/><line className="rwy-tdz" x1="277" y1="140" x2="277" y2="158"/>
                          <line className="rwy-tdz" x1="223" y1="248" x2="223" y2="266"/><line className="rwy-tdz" x1="229" y1="248" x2="229" y2="266"/><line className="rwy-tdz" x1="271" y1="248" x2="271" y2="266"/><line className="rwy-tdz" x1="277" y1="248" x2="277" y2="266"/>
                          <line className="rwy-tdz" x1="223" y1="286" x2="223" y2="304"/><line className="rwy-tdz" x1="229" y1="286" x2="229" y2="304"/><line className="rwy-tdz" x1="271" y1="286" x2="271" y2="304"/><line className="rwy-tdz" x1="277" y1="286" x2="277" y2="304"/>
                          <line className="rwy-tdz" x1="223" y1="742" x2="223" y2="760"/><line className="rwy-tdz" x1="229" y1="742" x2="229" y2="760"/><line className="rwy-tdz" x1="271" y1="742" x2="271" y2="760"/><line className="rwy-tdz" x1="277" y1="742" x2="277" y2="760"/>
                          <line className="rwy-tdz" x1="223" y1="596" x2="223" y2="614"/><line className="rwy-tdz" x1="229" y1="596" x2="229" y2="614"/><line className="rwy-tdz" x1="271" y1="596" x2="271" y2="614"/><line className="rwy-tdz" x1="277" y1="596" x2="277" y2="614"/>
                          <line className="rwy-tdz" x1="223" y1="558" x2="223" y2="576"/><line className="rwy-tdz" x1="229" y1="558" x2="229" y2="576"/><line className="rwy-tdz" x1="271" y1="558" x2="271" y2="576"/><line className="rwy-tdz" x1="277" y1="558" x2="277" y2="576"/>
                          <line className="twy-edge" x1="150" y1="60"  x2="150" y2="840"/><line className="twy-cl" x1="150" y1="60" x2="150" y2="840"/>
                          <line className="twy-edge" x1="350" y1="60"  x2="350" y2="840"/><line className="twy-cl" x1="350" y1="60" x2="350" y2="840"/>
                          <path className="twy-edge" d="M 150 60 Q 150 30 250 30 Q 350 30 350 60"/>
                          <path className="twy-edge" d="M 150 840 Q 150 870 250 870 Q 350 870 350 840"/>
                          <path className="twy-edge" d="M 218 200 Q 185 220 150 250"/><path className="twy-edge" d="M 218 600 Q 185 630 150 660"/>
                          <path className="twy-edge" d="M 282 240 Q 315 265 350 290"/><path className="twy-edge" d="M 282 580 Q 315 610 350 640"/>
                          <line className="twy-edge" x1="150" y1="180" x2="218" y2="180"/><line className="twy-cl" x1="150" y1="180" x2="218" y2="180"/>
                          <line className="twy-edge" x1="150" y1="680" x2="218" y2="680"/><line className="twy-cl" x1="150" y1="680" x2="218" y2="680"/>
                          <line className="twy-edge" x1="282" y1="180" x2="350" y2="180"/><line className="twy-cl" x1="282" y1="180" x2="350" y2="180"/>
                          <line className="twy-edge" x1="282" y1="680" x2="350" y2="680"/><line className="twy-cl" x1="282" y1="680" x2="350" y2="680"/>
                          <line className="twy-edge" x1="150" y1="450" x2="218" y2="450"/><line className="twy-edge" x1="282" y1="450" x2="350" y2="450"/>
                          <line className="twy-cl"  x1="150" y1="450" x2="218" y2="450"/><line className="twy-cl"  x1="282" y1="450" x2="350" y2="450"/>
                          <line className="hold" x1="210" y1="175" x2="290" y2="175"/>
                          <line className="hold" x1="210" y1="685" x2="290" y2="685"/>
                          <rect className="apron-edge" x="42" y="50" width="100" height="260" rx="5"/>
                          <line className="apron-edge" x1="142" y1="90"  x2="120" y2="90"/><line className="apron-edge" x1="142" y1="130" x2="120" y2="130"/><line className="apron-edge" x1="142" y1="170" x2="120" y2="170"/><line className="apron-edge" x1="142" y1="210" x2="120" y2="210"/><line className="apron-edge" x1="142" y1="250" x2="120" y2="250"/>
                          <line className="twy-cl" x1="118" y1="50"  x2="118" y2="310"/>
                          <rect className="apron-edge" x="358" y="590" width="100" height="250" rx="5"/>
                          <line className="apron-edge" x1="358" y1="630" x2="380" y2="630"/><line className="apron-edge" x1="358" y1="670" x2="380" y2="670"/><line className="apron-edge" x1="358" y1="710" x2="380" y2="710"/><line className="apron-edge" x1="358" y1="750" x2="380" y2="750"/>
                          <line className="twy-cl" x1="382" y1="590" x2="382" y2="840"/>
                        </svg>
                    </div>
                    {/* Scene group: plane + rings — scale() on parent scales both together */}
                    {/* base sizes × scene scale(1.4) = final visual size             */}
                    <div className="auth-scene" aria-hidden="true">
                        <div className="auth-rings">
                            {/* base ring sizes: [57,107,164,229,307] × 1.4 ≈ [80,150,230,320,430] */}
                            {[57,107,164,229,307].map(s => (
                                <div key={s} className="auth-ring" style={{ width: s, height: s }} />
                            ))}
                        </div>
                        <div className="auth-crosshair">
                            <div className="auth-ch-h" /><div className="auth-ch-v" />
                        </div>
                        <A380TopView />
                    </div>
                    <div className="auth-left-footer">
                        <span className="auth-left-tag">A388 · Airbus A380-800</span>
                        <span className="auth-left-tag">ADS-B TRACK ACTIVE</span>
                    </div>
                </div>

                {/* ══ RIGHT — Boarding Pass floats over left panel ══ */}
                <div className={`auth-right-area${tearing ? ' auth-tearing' : ''}`}>
                <div className="auth-right" ref={cardRef}>

                    {/* Airline header */}
                    <div className="auth-bp-header">
                        <div className="auth-bp-logo">
                            <AeroIcon size={28} />
                            <div>
                                <div className="auth-bp-name">AEROSTRAT</div>
                                <div className="auth-bp-sub">Aviation Intelligence</div>
                            </div>
                        </div>
                        <div className="auth-bp-right">
                            <div className="auth-bp-class-label">CLASS</div>
                            <div className="auth-bp-class-val">MEMBER</div>
                        </div>
                        <button className="auth-close" onClick={onClose}><X size={13} /></button>
                    </div>

                    {/* Route */}
                    <div className="auth-bp-route">
                        <div>
                            <div className="auth-bp-code">LOG</div>
                            <div className="auth-bp-city">Flight Log</div>
                        </div>
                        <div className="auth-bp-mid">
                            <div className="auth-bp-line">
                                <div className="auth-bp-dot" />
                                <div className="auth-bp-dash" />
                                <span className="auth-bp-plane">✈</span>
                                <div className="auth-bp-dash" />
                                <div className="auth-bp-dot" />
                            </div>
                            <div className="auth-bp-fltnum">AS-001</div>
                        </div>
                        <div style={{ textAlign: 'right' }}>
                            <div className="auth-bp-code">MAP</div>
                            <div className="auth-bp-city">Radar View</div>
                        </div>
                    </div>

                    {/* Info grid */}
                    <div className="auth-bp-grid">
                        <div className="auth-bp-cell">
                            <div className="auth-bp-cl">DATE</div>
                            <div className="auth-bp-cv">{today}</div>
                        </div>
                        <div className="auth-bp-cell">
                            <div className="auth-bp-cl">GATE</div>
                            <div className="auth-bp-cv">A-01</div>
                        </div>
                        <div className="auth-bp-cell">
                            <div className="auth-bp-cl">BOARDING</div>
                            <div className="auth-bp-cv">NOW</div>
                        </div>
                    </div>

                    {/* Tabs */}
                    <div className="auth-tabs">
                        <button className={`auth-tab ${mode==='login'?'active':''}`}
                            onClick={() => { setMode('login'); setError(''); }}>Sign In</button>
                        <button className={`auth-tab ${mode==='register'?'active':''}`}
                            onClick={() => { setMode('register'); setError(''); }}>Register</button>
                    </div>

                    {/* Social login */}
                    {hasOAuth && (
                        <div className="auth-social">
                            {oauthConfig.google && (
                                <a href="/api/auth/google" className="auth-social-btn google">
                                    <GoogleIcon />
                                    <span>Continue with Google</span>
                                </a>
                            )}
                            {oauthConfig.facebook && (
                                <a href="/api/auth/facebook" className="auth-social-btn facebook">
                                    <FacebookIcon />
                                    <span>Continue with Facebook</span>
                                </a>
                            )}
                            <div className="auth-divider">
                                <div className="auth-divider-line" />
                                <span>or</span>
                                <div className="auth-divider-line" />
                            </div>
                        </div>
                    )}

                    {/* Form — id 讓外部 stub 的 button 能 submit */}
                    <form id="auth-form" className="auth-form" onSubmit={handleSubmit}>
                        <div className="auth-fg">
                            <div className="auth-fl">PASSENGER NAME / USERNAME</div>
                            <div className="auth-fi">
                                <User size={13} className="auth-ficon" />
                                <input ref={inputRef} type="text" placeholder=""
                                    value={username} onChange={e => setUsername(e.target.value)}
                                    autoComplete="username" required />
                            </div>
                        </div>

                        {mode === 'register' && (
                            <div className="auth-fg">
                                <div className="auth-fl">EMAIL <span className="auth-opt">OPTIONAL</span></div>
                                <div className="auth-fi">
                                    <Mail size={13} className="auth-ficon" />
                                    <input type="email" placeholder=""
                                        value={email} onChange={e => setEmail(e.target.value)}
                                        autoComplete="email" />
                                </div>
                            </div>
                        )}

                        <div className="auth-fg last">
                            <div className="auth-fl">SECURITY CODE / PASSWORD</div>
                            <div className="auth-fi">
                                <Lock size={13} className="auth-ficon" />
                                <input type="password" placeholder=""
                                    value={password} onChange={e => setPassword(e.target.value)}
                                    autoComplete={mode==='login'?'current-password':'new-password'}
                                    required />
                            </div>
                        </div>

                        {error && (
                            <div className="auth-error">
                                <AlertCircle size={12} /> {error}
                            </div>
                        )}

                        {/* Tear line — 留在卡片內，作為 clip 的基準 */}
                        <div className="auth-tear" ref={tearRef}>
                            <div className="auth-tear-line" />
                        </div>
                    </form>
                </div>{/* /auth-right */}

                {/* Stub 移到 auth-right 外部，不受 clip-path 影響 */}
                <div className={`auth-stub${tearing ? ' auth-stub--tear' : ''}`} ref={stubRef}>
                    <button type="submit" form="auth-form" className="auth-submit" disabled={loading}>
                        {loading ? 'Please wait…'
                            : mode === 'login' ? 'Board Now →' : 'Activate Account →'}
                    </button>
                    <div className="auth-barcode" aria-hidden="true">
                        {BARS.map((h, i) => <span key={i} style={{ height: h + 'px' }} />)}
                    </div>
                </div>

                </div>{/* auth-right-area */}
            </div>
        </div>
    );
}
