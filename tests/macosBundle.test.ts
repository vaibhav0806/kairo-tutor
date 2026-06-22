import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('macOS bundle permissions', () => {
  test('codesigns the app with microphone audio input entitlement', () => {
    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    expect(tauriConfig.bundle.macOS.entitlements).toBe('Entitlements.plist');

    const entitlements = readFileSync('src-tauri/Entitlements.plist', 'utf8');
    expect(entitlements).toContain('<key>com.apple.security.device.audio-input</key>');
    expect(entitlements).toContain('<true/>');
  });

  test('declares the microphone usage reason shown by macOS', () => {
    const infoPlist = readFileSync('src-tauri/Info.plist', 'utf8');
    expect(infoPlist).toContain('<key>NSMicrophoneUsageDescription</key>');
    expect(infoPlist).toContain('voice input during tutoring sessions');
  });

  test('configures a hidden transparent always-on-top overlay window', () => {
    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const overlayWindow = tauriConfig.app.windows.find(
      (windowConfig: { label: string }) => windowConfig.label === 'overlay'
    );

    expect(tauriConfig.app.macOSPrivateApi).toBe(true);
    expect(overlayWindow).toMatchObject({
      label: 'overlay',
      title: 'Kairo Tutor Overlay',
      url: 'index.html#/overlay',
      create: false,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      visible: false,
      skipTaskbar: true,
      focus: false,
      focusable: false,
      shadow: false
    });
  });

  test('configures a hidden compact notch assistant window', () => {
    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const notchWindow = tauriConfig.app.windows.find(
      (windowConfig: { label: string }) => windowConfig.label === 'notch'
    );

    expect(notchWindow).toMatchObject({
      label: 'notch',
      title: 'Kairo Tutor',
      url: 'index.html#/notch',
      create: false,
      width: 380,
      height: 78,
      transparent: true,
      decorations: false,
      alwaysOnTop: true,
      visible: false,
      skipTaskbar: true,
      focus: false,
      focusable: false,
      shadow: false
    });
  });

  test('keeps the main debug window hidden on normal launch', () => {
    const tauriConfig = JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8'));
    const mainWindow = tauriConfig.app.windows.find(
      (windowConfig: { label: string }) => windowConfig.label === 'main'
    );

    expect(mainWindow).toMatchObject({
      label: 'main',
      visible: false,
      focus: false
    });
  });

  test('allows both main and overlay windows in the default capability scope', () => {
    const capability = JSON.parse(readFileSync('src-tauri/capabilities/default.json', 'utf8'));

    expect(capability.windows).toEqual(expect.arrayContaining(['main', 'overlay', 'notch']));
  });

  test('owns the activation shortcut in the native app shell', () => {
    const nativeSource = readFileSync('src-tauri/src/lib.rs', 'utf8');

    expect(nativeSource).toContain(
      'const KAIRO_ACTIVATION_SHORTCUT: &str = "CommandOrControl+Shift+Space";'
    );
    expect(nativeSource).toContain('.with_shortcut(KAIRO_ACTIVATION_SHORTCUT)');
    expect(nativeSource).toContain('app.emit("activation:shortcut", ())');
  });
});
