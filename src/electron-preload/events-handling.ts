import {IPC_MAIN_API, IpcMainApiEndpoints} from "src/shared/api/main";
import {Logger} from "src/shared/model/common";

type ObservableElement = Pick<HTMLElement, "addEventListener" | "removeEventListener">;

const processedKeyDownElements = new WeakMap<ObservableElement, ReturnType<typeof registerDocumentKeyDownEventListener>>();
const processedClickElements = new WeakMap<ObservableElement, ReturnType<typeof registerDocumentClickEventListener>>();
const keyCodes = {
    A: 65,
    C: 67,
    V: 86,
    F: 70,
    F12: 123,
} as const;

export function registerDocumentKeyDownEventListener<E extends ObservableElement>(
    element: E,
    logger: Logger,
): {
    unsubscribe: () => void;
    eventHandler: (event: KeyboardEvent) => Promise<void>;
} {
    let subscription = processedKeyDownElements.get(element);

    if (subscription) {
        return subscription;
    }

    const apiClient = IPC_MAIN_API.client({options: {logger}});
    const eventHandlerArgs: readonly ["keydown", (event: KeyboardEvent) => Promise<void>] = [
        "keydown",
        async (event: Readonly<KeyboardEvent>) => {
            if (event.keyCode === keyCodes.F12) {
                await apiClient("toggleControls")();
                return;
            }

            const el: Element | null = (event.target as any);
            const cmdOrCtrl = event.ctrlKey || event.metaKey;

            if (!cmdOrCtrl) {
                return;
            }

            if (event.keyCode === keyCodes.F) {
                await apiClient("findInPageDisplay")({visible: true});
                return;
            }

            let type: Arguments<IpcMainApiEndpoints["hotkey"]>[0]["type"] | undefined;

            if (!el) {
                return;
            }

            if (event.keyCode === keyCodes.A) {
                type = "selectAll";
            } else if (event.keyCode === keyCodes.C && !isPasswordInput(el)) {
                type = "copy";
            } else if (event.keyCode === keyCodes.V && isWritable(el)) {
                type = "paste";
            }

            if (!type) {
                return;
            }

            await apiClient("hotkey")({type});
        },
    ];
    const [, eventHandler] = eventHandlerArgs;

    element.addEventListener(...eventHandlerArgs);

    subscription = {
        unsubscribe: () => {
            element.removeEventListener(...eventHandlerArgs);
            processedKeyDownElements.delete(element);
        },
        eventHandler,
    };

    processedKeyDownElements.set(element, subscription);

    return subscription;
}

export function registerDocumentClickEventListener<E extends ObservableElement>(
    element: E,
    logger: Logger,
): {
    unsubscribe: () => void;
    eventHandler: (event: MouseEvent) => Promise<void>;
} {
    let subscription = processedClickElements.get(element);

    if (subscription) {
        return subscription;
    }

    const apiClient = IPC_MAIN_API.client({options: {logger}});
    const eventHandlerArgs: ["click", (event: MouseEvent) => Promise<void>] = [
        "click",
        async (event: MouseEvent) => await callDocumentClickEventListener(event, logger, apiClient),
    ];
    const [, eventHandler] = eventHandlerArgs;

    element.addEventListener(...eventHandlerArgs);

    subscription = {
        unsubscribe: () => {
            element.removeEventListener(...eventHandlerArgs);
            processedClickElements.delete(element);
        },
        eventHandler,
    };

    processedClickElements.set(element, subscription);

    return subscription;
}

export async function callDocumentClickEventListener(
    event: MouseEvent,
    logger: Logger,
    apiClient?: ReturnType<typeof IPC_MAIN_API.client>,
) {
    const {element: el, link, href} = resolveLink(event.target as Element);

    if (!link || el.classList.contains("prevent-default-event")) {
        return;
    }

    if (
        !href
        ||
        !(href.startsWith("https://") || href.startsWith("http://"))
    ) {
        return;
    }

    event.preventDefault();

    const client = apiClient || IPC_MAIN_API.client({options: {logger}});
    const method = client("openExternal");

    await method({url: href});
}

function resolveLink(element: Element): { element: Element, link?: boolean; href?: string } {
    const parentScanState: {
        element: (Node & ParentNode) | null | Element;
        link?: boolean;
        iterationAllowed: number;
    } = {
        element,
        iterationAllowed: 3,
    };

    while (parentScanState.element && parentScanState.iterationAllowed) {
        if (
            parentScanState.element.nodeType === Node.ELEMENT_NODE
            &&
            ("tagName" in parentScanState.element && parentScanState.element.tagName.toLowerCase() === "a")
        ) {
            parentScanState.link = true;
            break;
        }
        parentScanState.element = parentScanState.element.parentNode;
        parentScanState.iterationAllowed--;
    }

    const result: ReturnType<typeof resolveLink> = {
        element: parentScanState.element as Element,
        link: parentScanState.link,
    };

    if (!result.link) {
        return result;
    }

    result.href = (result.element as HTMLLinkElement).href;

    return result;
}

function isInput(el: Element | HTMLInputElement): el is HTMLInputElement {
    return el.tagName === "INPUT";
}

function isTextarea(el: Element | HTMLTextAreaElement): el is HTMLTextAreaElement {
    return el.tagName === "TEXTAREA";
}

function isWritable(el: Element): boolean {
    const writableInput = (
        (isInput(el) || isTextarea(el))
        &&
        !el.disabled && !el.hasAttribute("disabled")
        &&
        !el.readOnly && !el.hasAttribute("readonly")
    );

    return writableInput || isContentEditableDeep(el);
}

function isContentEditableDeep(el: Node | Element | null): boolean {
    let value = false;

    while (el && !value) {
        value = "tagName" in el && isContentEditable(el);
        el = el.parentNode;
    }

    return value;
}

function isContentEditable(el: Element): boolean {
    return el.hasAttribute("contenteditable");
}

function isPasswordInput(el: Element): boolean {
    return (
        isInput(el)
        &&
        String(el.getAttribute("type")).toLowerCase() === "password"
    );
}
