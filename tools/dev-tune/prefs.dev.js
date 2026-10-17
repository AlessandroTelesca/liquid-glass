import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {buildPreferences} from './preferences/pages.js';
import {addTuneDefaults} from './preferences/dev-tune.js';

export default class LiquidGlassPreferences extends ExtensionPreferences {
  fillPreferencesWindow(window) {
    const settings = this.getSettings();
    buildPreferences(window, settings);
    addTuneDefaults(window, settings);
  }
}
