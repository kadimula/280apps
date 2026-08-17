import type { SelectorSession } from "@/lib/integrations";
import type { PickedSheet } from "@/lib/mock-sheets";

// Loads the Google Picker on demand and opens it scoped to spreadsheets the
// connection can already see (the drive.file OAuth token). Resolves the picked
// spreadsheet, or null when the owner cancels. Real-Google only: the dialog's
// mock path never calls this, so the picker script loads solely in a live env.

const GAPI_SRC = "https://apis.google.com/js/api.js";

interface PickerDoc {
  id: string;
  name: string;
}
interface PickerData {
  action: string;
  docs?: PickerDoc[];
}
interface PickerView {
  setSelectFolderEnabled(value: boolean): PickerView;
  setMode(mode: unknown): PickerView;
}
interface PickerObject {
  setVisible(value: boolean): void;
}
interface PickerBuilder {
  addView(view: PickerView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(id: string): PickerBuilder;
  setCallback(callback: (data: PickerData) => void): PickerBuilder;
  build(): PickerObject;
}
interface PickerNamespace {
  DocsView: new (viewId: unknown) => PickerView;
  PickerBuilder: new () => PickerBuilder;
  ViewId: { SPREADSHEETS: unknown };
  DocsViewMode: { LIST: unknown };
  Action: { PICKED: string; CANCEL: string };
}
interface Gapi {
  load(name: string, config: { callback: () => void }): void;
}

declare global {
  interface Window {
    gapi?: Gapi;
    google?: { picker: PickerNamespace };
  }
}

function loadGapi(): Promise<Gapi> {
  return new Promise((resolve, reject) => {
    if (window.gapi) return resolve(window.gapi);
    const done = () =>
      window.gapi ? resolve(window.gapi) : reject(new Error("Google API unavailable"));
    const fail = () => reject(new Error("Google API failed to load"));
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GAPI_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener("load", done);
      existing.addEventListener("error", fail);
      return;
    }
    const script = document.createElement("script");
    script.src = GAPI_SRC;
    script.async = true;
    script.onload = done;
    script.onerror = fail;
    document.head.appendChild(script);
  });
}

export async function openGooglePicker(
  session: SelectorSession,
): Promise<PickedSheet | null> {
  const gapi = await loadGapi();
  await new Promise<void>((resolve) => gapi.load("picker", { callback: resolve }));
  const picker = window.google!.picker;
  return new Promise<PickedSheet | null>((resolve) => {
    const view = new picker.DocsView(picker.ViewId.SPREADSHEETS)
      .setSelectFolderEnabled(false)
      .setMode(picker.DocsViewMode.LIST);
    new picker.PickerBuilder()
      .addView(view)
      .setOAuthToken(session.accessToken)
      .setDeveloperKey(session.pickerApiKey)
      .setAppId(session.projectNumber)
      .setCallback((data) => {
        if (data.action === picker.Action.PICKED) {
          const doc = data.docs?.[0];
          resolve(doc ? { id: doc.id, name: doc.name } : null);
        } else if (data.action === picker.Action.CANCEL) {
          resolve(null);
        }
      })
      .build()
      .setVisible(true);
  });
}
