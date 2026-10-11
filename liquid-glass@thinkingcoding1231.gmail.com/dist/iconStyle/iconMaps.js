// The style maps of icon files, made by the icon worker (iconWorker.ts) and
// kept in the user's cache directory, so that an icon is taken apart once.
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { WorkerProcess } from '../workers/workerProcess.js';
import { iconStyleTexture } from './iconEffect.js';
import { MAP_SIZE } from './styleMap.js';
// Changes whenever the maps would come out differently, so that older ones are made again.
const MAP_VERSION = 7;

function loadFile(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.load_contents_async(cancellable, (_f, res) => {
            try {
                resolve(file.load_contents_finish(res)[1]);
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

function modified(file, cancellable) {
    return new Promise((resolve, reject) => {
        file.query_info_async('time::modified', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, cancellable, (_f, res) => {
            try {
                resolve(file.query_info_finish(res).get_attribute_uint64('time::modified'));
            }
            catch (e) {
                reject(e);
            }
        });
    });
}

export class IconMaps {
    _worker;
    // By icon file: its map's and its tones' textures.
    _maps = new Map();
    _cancellable = new Gio.Cancellable();
    _dir = `${GLib.get_user_cache_dir()}/liquid-glass/icon-maps`;

    constructor(extensionPath, logger) {
        this._worker = new WorkerProcess(`${extensionPath}/dist/iconStyle/iconWorker.js`, 'icon worker', logger);
    }

    /** The map of the icon in `path`. Rejects when it cannot be made. */
    get(path) {
        let map = this._maps.get(path);
        if (!map) {
            map = this._load(path);
            // A failure is not kept: the file may be readable later.
            map.catch(() => this._maps.delete(path));
            this._maps.set(path, map);
        }
        return map;
    }

    async _load(path) {
        const time = await modified(Gio.File.new_for_path(path), this._cancellable);
        const key = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, `${MAP_VERSION}|${MAP_SIZE}|${path}|${time}`, -1);
        const cache = Gio.File.new_for_path(`${this._dir}/${key}`);
        let bytes = null;
        try {
            bytes = await loadFile(cache, this._cancellable);
        }
        catch (e) {
            if (!(e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND)))
                throw e;
        }
        if (!bytes) {
            await this._worker.request({ file: path, cache: cache.get_path() });
            bytes = await loadFile(cache, this._cancellable);
        }
        const length = MAP_SIZE * MAP_SIZE * 4;
        if (bytes.length !== length * 2)
            throw new Error(`${cache.get_path()} is not a style map`);
        return { map: iconStyleTexture(bytes.subarray(0, length)), tone: iconStyleTexture(bytes.subarray(length)) };
    }

    destroy() {
        this._cancellable.cancel();
        this._worker.destroy();
        this._maps.clear();
    }
}
