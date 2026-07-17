declare module "@novnc/novnc" {
    export default class RFB {
        constructor(target: HTMLElement, url: string, options?: { shared?: boolean });
        background: string;
        scaleViewport: boolean;
        viewOnly: boolean;
        addEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
        removeEventListener(type: string, listener: EventListenerOrEventListenerObject): void;
        disconnect(): void;
    }
}
