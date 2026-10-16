#!/usr/bin/gjs
// Для Termux с CJS замени shebang на:
// #!/usr/bin/cjs
//
// Icon Theme Comparer

imports.gi.versions.Gtk = '3.0';
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const Gdk = imports.gi.Gdk;
const GdkPixbuf = imports.gi.GdkPixbuf;

Gio._promisify(Gio.File.prototype, 'enumerate_children_async', 'enumerate_children_finish');
Gio._promisify(Gio.FileEnumerator.prototype, 'next_files_async', 'next_files_finish');
Gio._promisify(Gio.File.prototype, 'query_info_async', 'query_info_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

Gtk.init(null);

// =====================================================================
// УТИЛИТЫ
// =====================================================================

function decodeContents(contents) {
    if (typeof contents === 'string') return contents;
    if (typeof TextDecoder !== 'undefined') {
        try { return new TextDecoder('utf-8').decode(contents); } catch (e) {}
    }
    let s = '';
    for (let i = 0; i < contents.length; i++) s += String.fromCharCode(contents[i]);
    return s;
}

function escapeMarkup(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

let _transparentPixbuf = null;
function getTransparentPixbuf() {
    if (!_transparentPixbuf) {
        _transparentPixbuf = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB, true, 8, 1, 1);
        _transparentPixbuf.fill(0x00000000);
    }
    return _transparentPixbuf;
}

const pixbufCache = new Map();

function pixbufFromFile(path, size) {
    const cacheKey = path + '::' + size;
    if (pixbufCache.has(cacheKey)) return pixbufCache.get(cacheKey);

    let result = null;
    try {
        let raw = GdkPixbuf.Pixbuf.new_from_file(path);
        let w = raw.get_width();
        let h = raw.get_height();

        if (w === size && h === size) {
            result = raw;
        } else {
            // Сохраняем пропорции, масштабируем NEAREST (без сглаживания)
            const scale = Math.min(size / w, size / h);
            const newW = Math.max(1, Math.round(w * scale));
            const newH = Math.max(1, Math.round(h * scale));
            const scaled = (newW === w && newH === h)
                ? raw
                : raw.scale_simple(newW, newH, GdkPixbuf.InterpType.NEAREST);

            if (newW === size && newH === size) {
                result = scaled;
            } else {
                const canvas = GdkPixbuf.Pixbuf.new(
                    GdkPixbuf.Colorspace.RGB, true, 8, size, size);
                canvas.fill(0x00000000);
                scaled.copy_area(0, 0, newW, newH, canvas,
                    Math.floor((size - newW) / 2),
                    Math.floor((size - newH) / 2));
                result = canvas;
            }
        }
    } catch (e) {
        result = null;
    }

    pixbufCache.set(cacheKey, result);
    return result;
}

function resolveTargetPath(themeDir, dirName, target) {
    try {
        let base = GLib.build_filenamev([themeDir, dirName]);
        return GLib.canonicalize_filename(target, base);
    } catch (e) { return null; }
}

// =====================================================================
// ПУТИ ПОИСКА ТЕМ И СПИСОК СИСТЕМНЫХ ТЕМ
// =====================================================================

function getIconSearchPaths() {
    const paths = [];
    paths.push(GLib.build_filenamev([GLib.get_home_dir(), '.icons']));
    paths.push(GLib.build_filenamev([GLib.get_user_data_dir(), 'icons']));
    for (const d of GLib.get_system_data_dirs()) {
        paths.push(GLib.build_filenamev([d, 'icons']));
    }
    paths.push('/usr/share/pixmaps');
    return paths;
}

function collectSystemThemeNames() {
    const names = [];
    const seen = new Set();
    for (const baseDir of getIconSearchPaths()) {
        const dir = Gio.File.new_for_path(baseDir);
        let enumerator;
        try {
            enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) { continue; }
        let info;
        while ((info = enumerator.next_file(null)) !== null) {
            if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;
            const n = info.get_name();
            if (seen.has(n)) continue;
            const indexPath = GLib.build_filenamev([baseDir, n, 'index.theme']);
            if (!Gio.File.new_for_path(indexPath).query_exists(null)) continue;
            seen.add(n);
            names.push(n);
        }
        enumerator.close(null);
    }
    names.sort();
    return names;
}

// =====================================================================
// НАСТРОЙКИ (сохраняются в ~/.config/compare-icon-themes/config.ini)
// =====================================================================

class Settings {
    constructor() {
        const configDir = GLib.build_filenamev([
            GLib.get_user_config_dir(), 'compare-icon-themes']);
        try { GLib.mkdir_with_parents(configDir, 0o755); } catch (e) {}
        this.path = GLib.build_filenamev([configDir, 'config.ini']);

        this.colors = {
            missing:      '#CC0000',
            symlinksOnly: '#800080',
            hasSymlinks:  '#0000CC',
            ok:           '#000000'
        };
        this.defaultTheme = '';
        this.load();
    }

    load() {
        try {
            const kf = new GLib.KeyFile();
            kf.load_from_file(this.path, GLib.KeyFileFlags.NONE);
            try { this.colors.missing      = kf.get_string('colors', 'missing'); } catch (e) {}
            try { this.colors.symlinksOnly = kf.get_string('colors', 'symlinks_only'); } catch (e) {}
            try { this.colors.hasSymlinks  = kf.get_string('colors', 'has_symlinks'); } catch (e) {}
            try { this.colors.ok           = kf.get_string('colors', 'ok'); } catch (e) {}
            try { this.defaultTheme        = kf.get_string('preview', 'default_theme'); } catch (e) {}
        } catch (e) {
            // файла нет — используем значения по умолчанию
        }
    }

    save() {
        const kf = new GLib.KeyFile();
        kf.set_string('colors', 'missing', this.colors.missing);
        kf.set_string('colors', 'symlinks_only', this.colors.symlinksOnly);
        kf.set_string('colors', 'has_symlinks', this.colors.hasSymlinks);
        kf.set_string('colors', 'ok', this.colors.ok);
        kf.set_string('preview', 'default_theme', this.defaultTheme);
        try { kf.save_to_file(this.path); } catch (e) {}
    }
}

// =====================================================================
// ОКНО НАСТРОЕК
// =====================================================================

class SettingsDialog {
    constructor(parent, settings, onSaved) {
        this.settings = settings;
        this.onSaved = onSaved;

        this.dialog = new Gtk.Dialog({
            title: 'Settings',
            transient_for: parent,
            modal: true,
            default_width: 480
        });
        this.dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        this.dialog.add_button('Save', Gtk.ResponseType.OK);

        this.buildUI();
    }

    buildUI() {
        const content = this.dialog.get_content_area();
        content.set_spacing(10);
        content.set_margin_start(12);
        content.set_margin_end(12);
        content.set_margin_top(12);
        content.set_margin_bottom(12);

        const grid = new Gtk.Grid({ row_spacing: 8, column_spacing: 12 });

        let row = 0;

        const colorHdr = new Gtk.Label({
            label: '<b>Status colors</b>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        grid.attach(colorHdr, 0, row, 2, 1);
        row++;

        const colorRows = [
            ['missing',      'Missing in some themes:'],
            ['symlinksOnly', 'Symlinks only:'],
            ['hasSymlinks',  'Has symlinks:'],
            ['ok',           'OK:']
        ];
        this.colorButtons = {};
        for (const [key, label] of colorRows) {
            const lbl = new Gtk.Label({ label: label, halign: Gtk.Align.START });
            const btn = new Gtk.ColorButton();
            const rgba = new Gdk.RGBA();
            if (rgba.parse(this.settings.colors[key] || '#000000')) {
                btn.set_rgba(rgba);
            }
            this.colorButtons[key] = btn;
            grid.attach(lbl, 0, row, 1, 1);
            grid.attach(btn, 1, row, 1, 1);
            row++;
        }

        const sep = new Gtk.Separator({ orientation: Gtk.Orientation.HORIZONTAL });
        grid.attach(sep, 0, row, 2, 1);
        row++;

        const themeHdr = new Gtk.Label({
            label: '<b>Preview theme</b>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        grid.attach(themeHdr, 0, row, 2, 1);
        row++;

        const themeHint = new Gtk.Label({
            label: 'Fallback icon theme for previews in the "Add system theme"\n' +
                   'dialog. Leave empty to use the icon from the theme itself\n' +
                   '(with fallback to the GTK default theme).',
            halign: Gtk.Align.START,
            xalign: 0,
            wrap: true
        });
        grid.attach(themeHint, 0, row, 2, 1);
        row++;

        this.themeCombo = Gtk.ComboBoxText.new_with_entry();
        const names = collectSystemThemeNames();
        for (const n of names) this.themeCombo.append_text(n);

        const entry = this.themeCombo.get_child();
        if (entry) {
            entry.set_width_chars(30);
            if (this.settings.defaultTheme) entry.set_text(this.settings.defaultTheme);
        }
        grid.attach(this.themeCombo, 0, row, 2, 1);

        content.pack_start(grid, true, true, 0);
        this.dialog.show_all();
    }

    run() {
        const response = this.dialog.run();

        if (response === Gtk.ResponseType.OK) {
            for (const key of Object.keys(this.colorButtons)) {
                const rgba = this.colorButtons[key].get_rgba();
                const r = Math.round(rgba.red * 255);
                const g = Math.round(rgba.green * 255);
                const b = Math.round(rgba.blue * 255);
                this.settings.colors[key] = '#' +
                    r.toString(16).padStart(2, '0') +
                    g.toString(16).padStart(2, '0') +
                    b.toString(16).padStart(2, '0');
            }

            let theme = '';
            const entry = this.themeCombo.get_child();
            if (entry) theme = entry.get_text();
            if (!theme) theme = this.themeCombo.get_active_text() || '';
            this.settings.defaultTheme = theme.trim();

            this.settings.save();
            if (this.onSaved) this.onSaved();
        }

        this.dialog.destroy();
    }
}

// =====================================================================
// КЛАСС ICONTHEME
// =====================================================================

class IconTheme {
    constructor(indexPath) {
        this.indexPath = indexPath;
        this.dir = GLib.path_get_dirname(indexPath);
        this.name = GLib.path_get_basename(this.dir);
        this.comment = '';
        this.example = '';
        this.directoryList = [];
        this.directories = new Map();
        this.icons = new Map();
        this.error = null;
        this._loaded = false;
    }

    async load(progress) {
        if (this._loaded) return true;
        try {
            const keyFile = new GLib.KeyFile();
            keyFile.load_from_file(this.indexPath, GLib.KeyFileFlags.NONE);

            try { this.name = keyFile.get_string('Icon Theme', 'Name') || this.name; } catch (e) {}
            try { this.comment = keyFile.get_string('Icon Theme', 'Comment') || ''; } catch (e) {}
            try { this.example = keyFile.get_string('Icon Theme', 'Example') || ''; } catch (e) {}

            let dirsStr = '';
            try { dirsStr = keyFile.get_string('Icon Theme', 'Directories') || ''; } catch (e) {}
            this.directoryList = dirsStr.split(',').map(s => s.trim()).filter(Boolean);

            for (const dirName of this.directoryList) {
                const info = { context: '', size: null, type: '', scale: null };
                try { info.context = keyFile.get_string(dirName, 'Context') || ''; } catch (e) {}
                try {
                    const sz = keyFile.get_integer(dirName, 'Size');
                    if (sz > 0) info.size = sz;
                } catch (e) {}
                try { info.type = keyFile.get_string(dirName, 'Type') || ''; } catch (e) {}
                try {
                    const sc = keyFile.get_integer(dirName, 'Scale');
                    if (sc > 0) info.scale = sc;
                } catch (e) {}
                this.directories.set(dirName, info);
            }

            await this.scanIconsAsync(progress);
            this._loaded = true;
            return true;
        } catch (e) {
            this.error = e.message || String(e);
            return false;
        }
    }

    async scanIconsAsync(progress) {
        const validExts = ['.png', '.svg', '.xpm'];
        const self = this;

        const totalDirs = this.directoryList.length;
        let processedDirs = 0;

        for (const dirName of this.directoryList) {
            if (progress && progress.isCancelled()) {
                this.icons.clear();
                throw new Error('Cancelled by user');
            }

            const dirInfo = this.directories.get(dirName);
            if (!dirInfo) {
                processedDirs++;
                continue;
            }

            if (progress) {
                const frac = totalDirs > 0 ? processedDirs / totalDirs : 0;
                progress.setStatus(frac,
                    'Scanning ' + dirName +
                    ' (' + (processedDirs + 1) + '/' + totalDirs + ')...');
            }

            const absDir = GLib.build_filenamev([this.dir, dirName]);
            const dir = Gio.File.new_for_path(absDir);

            let enumerator = null;
            try {
                enumerator = await dir.enumerate_children_async(
                    'standard::name,standard::type,standard::is-symlink,standard::symlink-target',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS,
                    GLib.PRIORITY_DEFAULT,
                    null);

                let fileInfos;
                do {
                    if (progress && progress.isCancelled()) {
                        throw new Error('Cancelled by user');
                    }
                    try {
                        fileInfos = await enumerator.next_files_async(
                            200, GLib.PRIORITY_DEFAULT, null);
                    } catch (e) {
                        break;
                    }

                    for (const info of fileInfos) {
                        const name = info.get_name();
                        const dot = name.lastIndexOf('.');
                        if (dot < 0) continue;
                        const ext = name.substring(dot).toLowerCase();
                        if (!validExts.includes(ext)) continue;

                        const baseName = name.substring(0, dot);
                        const isSymlink = info.get_is_symlink();
                        let target = null;
                        if (isSymlink) {
                            try { target = info.get_symlink_target(); } catch (e) {}
                        }

                        if (!self.icons.has(baseName)) {
                            self.icons.set(baseName, { occurrences: [] });
                        }

                        self.icons.get(baseName).occurrences.push({
                            theme: self,
                            dirName: dirName,
                            fileName: name,
                            fullPath: absDir + '/' + name,
                            relPath: dirName + '/' + name,
                            size: dirInfo.size,
                            context: dirInfo.context,
                            type: dirInfo.type,
                            isSymlink: isSymlink,
                            target: target,
                            resolvedTarget: isSymlink
                                ? resolveTargetPath(self.dir, dirName, target)
                                : null
                        });
                    }
                } while (fileInfos.length > 0);
            } catch (e) {
                if (e && /Cancelled/.test(e.message || '')) throw e;
                // Проблема в одном подкаталоге не должна ронять всю тему.
            } finally {
                if (enumerator) {
                    try { enumerator.close(null); } catch (e) {}
                }
            }

            processedDirs++;
        }

        if (progress) progress.setStatus(1.0, 'Done');
    }
}

// =====================================================================
// ДИАЛОГ ПРОГРЕССА С КНОПКОЙ ОТМЕНЫ
// =====================================================================

class ProgressDialog {
    constructor(parent, title, text) {
        this.cancelled = false;
        this.dialog = new Gtk.Dialog({
            title: title || 'Please wait',
            transient_for: parent,
            modal: true,
            default_width: 440
        });
        this.dialog.set_deletable(false);
        this.dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);

        const content = this.dialog.get_content_area();
        content.set_spacing(8);
        content.set_margin_start(12);
        content.set_margin_end(12);
        content.set_margin_top(12);
        content.set_margin_bottom(12);

        this.label = new Gtk.Label({
            label: text || '',
            halign: Gtk.Align.START,
            xalign: 0,
            wrap: true
        });
        content.pack_start(this.label, false, false, 0);

        this.progress = new Gtk.ProgressBar();
        this.progress.set_show_text(true);
        this.progress.set_text('Preparing...');
        this.progress.set_fraction(0);
        content.pack_start(this.progress, false, false, 0);

        this.dialog.connect('response', (d, resp) => {
            if (resp === Gtk.ResponseType.CANCEL) {
                this.cancelled = true;
            }
        });

        this.dialog.show_all();
        // Немедленно отрисовываем диалог, чтобы он появился до
        // старта синхронной части загрузки.
        while (Gtk.events_pending()) {
            Gtk.main_iteration_do(false);
        }
    }

    // fraction — 0.0..1.0, text — подпись на полосе.
    // Покадрово "прокачиваем" главный цикл, чтобы отрисовались
    // изменения и сработала кнопка Cancel.
    setStatus(fraction, text) {
        if (this.cancelled) return;
        if (typeof fraction === 'number' && fraction >= 0 && fraction <= 1) {
            this.progress.set_fraction(fraction);
        }
        if (text != null) this.progress.set_text(text);
        while (Gtk.events_pending()) {
            Gtk.main_iteration_do(false);
        }
    }

    isCancelled() {
        return this.cancelled;
    }

    close() {
        try { this.dialog.destroy(); } catch (e) {}
    }
}

// =====================================================================
// ДИАЛОГ ВЫБОРА СИСТЕМНЫХ ТЕМ
// =====================================================================

class SystemThemesDialog {
    constructor(parent, app) {
        this.app = app;
        this.dialog = new Gtk.Dialog({
            title: 'Add system icon themes',
            transient_for: parent,
            modal: true,
            default_width: 820,
            default_height: 520
        });
        this.dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        this.dialog.add_button('Add selected', Gtk.ResponseType.OK);

        this.buildUI();
    }

    buildUI() {
        const content = this.dialog.get_content_area();
        content.set_spacing(6);
        content.set_margin_start(10);
        content.set_margin_end(10);
        content.set_margin_top(10);
        content.set_margin_bottom(10);

        const label = new Gtk.Label({
            label: 'Select one or more system themes to add:',
            halign: Gtk.Align.START
        });
        content.pack_start(label, false, false, 0);

        this.store = new Gtk.ListStore();
        this.store.set_column_types([
            GdkPixbuf.Pixbuf,    // 0 preview
            GObject.TYPE_STRING, // 1 name
            GObject.TYPE_STRING, // 2 path
            GObject.TYPE_STRING  // 3 example
        ]);

        this.view = new Gtk.TreeView({ model: this.store });
        this.view.get_selection().set_mode(Gtk.SelectionMode.MULTIPLE);

        const pixRenderer = new Gtk.CellRendererPixbuf();
        pixRenderer.set_property('xpad', 4);
        pixRenderer.set_property('ypad', 2);
        const pixCol = new Gtk.TreeViewColumn({ title: 'Preview' });
        pixCol.pack_start(pixRenderer, false);
        pixCol.add_attribute(pixRenderer, 'pixbuf', 0);
        pixCol.set_min_width(56);
        pixCol.set_resizable(true);
        this.view.append_column(pixCol);

        const nameRenderer = new Gtk.CellRendererText();
        nameRenderer.set_property('ellipsize', 3);
        const nameCol = new Gtk.TreeViewColumn({ title: 'Name' });
        nameCol.pack_start(nameRenderer, true);
        nameCol.add_attribute(nameRenderer, 'text', 1);
        nameCol.set_min_width(160);
        nameCol.set_resizable(true);
        nameCol.set_sort_column_id(1);
        nameCol.set_clickable(true);
        nameCol.set_expand(true);
        this.view.append_column(nameCol);

        const pathRenderer = new Gtk.CellRendererText();
        pathRenderer.set_property('ellipsize', 3);
        const pathCol = new Gtk.TreeViewColumn({ title: 'Path' });
        pathCol.pack_start(pathRenderer, true);
        pathCol.add_attribute(pathRenderer, 'text', 2);
        pathCol.set_min_width(300);
        pathCol.set_resizable(true);
        pathCol.set_sort_column_id(2);
        pathCol.set_clickable(true);
        pathCol.set_expand(true);
        this.view.append_column(pathCol);

        this.store.set_sort_column_id(1, Gtk.SortType.ASCENDING);

        const scroll = new Gtk.ScrolledWindow();
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        scroll.add(this.view);
        content.pack_start(scroll, true, true, 0);

        this.dialog.show_all();
        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this.scanSystemThemes();
            return false;
        });
    }

    scanSystemThemes() {
        const searchDirs = getIconSearchPaths();

        const seen = new Set();
        const themes = [];

        for (const baseDir of searchDirs) {
            const dir = Gio.File.new_for_path(baseDir);
            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    'standard::name,standard::type',
                    Gio.FileQueryInfoFlags.NONE, null);
            } catch (e) {
                continue;
            }

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                if (info.get_file_type() !== Gio.FileType.DIRECTORY) continue;

                const themeName = info.get_name();
                const themeDir = GLib.build_filenamev([baseDir, themeName]);
                const indexPath = GLib.build_filenamev([themeDir, 'index.theme']);

                if (seen.has(indexPath)) continue;
                seen.add(indexPath);

                const indexFile = Gio.File.new_for_path(indexPath);
                if (!indexFile.query_exists(null)) continue;

                try {
                    const kf = new GLib.KeyFile();
                    kf.load_from_file(indexPath, GLib.KeyFileFlags.NONE);

                    // --- Фильтр тем курсоров ---
                    // У настоящих иконочных тем в index.theme всегда есть
                    // непустой ключ Directories. У тем курсоров его нет.
                    // Если и он отсутствует — пропускаем тему.
                    let dirsStr = '';
                    try {
                        dirsStr = kf.get_string('Icon Theme', 'Directories') || '';
                    } catch (e) {}
                    if (!dirsStr.trim()) continue;

                    // Дополнительно: если в каталоге темы есть только
                    // подкаталог cursors (а иконочных директорий нет) —
                    // тоже пропускаем.
                    const cursorsDir = GLib.build_filenamev([themeDir, 'cursors']);
                    if (GLib.file_test(cursorsDir, GLib.FileTest.IS_DIR)) {
                        const listed = dirsStr.split(',').map(s => s.trim()).filter(Boolean);
                        // Проверяем, есть ли хоть одна реально
                        // существующая директория с иконками.
                        let hasRealDir = false;
                        for (const d of listed) {
                            const sub = GLib.build_filenamev([themeDir, d]);
                            if (GLib.file_test(sub, GLib.FileTest.IS_DIR)) {
                                hasRealDir = true;
                                break;
                            }
                        }
                        if (!hasRealDir) continue;
                    }

                    let displayName = themeName;
                    try {
                        displayName = kf.get_string('Icon Theme', 'Name') || themeName;
                    } catch (e) {}
                    let example = '';
                    try {
                        example = kf.get_string('Icon Theme', 'Example') || '';
                    } catch (e) {}

                    themes.push({
                        name: displayName,
                        dirName: themeName,
                        dir: themeDir,
                        indexPath: indexPath,
                        example: example
                    });
                } catch (e) {
                    // пропускаем нечитаемые index.theme
                }
            }
            enumerator.close(null);
        }

        themes.sort((a, b) => a.name.localeCompare(b.name));

        // Заполняем модель без pixbuf-колонки (не задаём null)
        for (const t of themes) {
            const iter = this.store.append();
            this.store.set(iter, [1, 2, 3], [t.name, t.dir, t.example]);
        }

        // Асинхронная загрузка превью по одной строке за такт
        let idx = 0;
        const loadNextPreview = () => {
            if (idx >= themes.length) return false;
            const rowIdx = idx;
            const t = themes[rowIdx];
            idx++;

            // Если Example нет — используем 'folder' как дефолтную иконку
            const exampleName = t.example || 'folder';
            const pix = this.findExampleIcon(t, exampleName);
            if (pix) {
                const [ok, iter] = this.store.get_iter_from_string(String(rowIdx));
                if (ok && iter) {
                    this.store.set(iter, [0], [pix]);
                }
            }

            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, loadNextPreview);
            return false;
        };

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, loadNextPreview);
    }

    findExampleIcon(themeInfo, exampleName) {
        if (!exampleName) exampleName = 'folder';

        // 1. Иконка из самой темы (или унаследованная ею).
        try {
            const it = Gtk.IconTheme.new();
            const parent = GLib.path_get_dirname(themeInfo.dir);
            it.append_search_path(parent);
            it.set_custom_theme(themeInfo.dirName);

            if (it.has_icon(exampleName)) {
                const pix = it.load_icon(exampleName, 48, 0);
                if (pix) return pix;
            }
            if (exampleName !== 'folder' && it.has_icon('folder')) {
                const pix = it.load_icon('folder', 48, 0);
                if (pix) return pix;
            }
        } catch (e) {}

        // 2. Иконка из темы по умолчанию, заданной в настройках.
        const defTheme = (this.app && this.app.settings)
            ? this.app.settings.defaultTheme
            : '';
        if (defTheme) {
            try {
                const it = Gtk.IconTheme.new();
                for (const p of getIconSearchPaths()) it.append_search_path(p);
                it.set_custom_theme(defTheme);

                if (it.has_icon(exampleName)) {
                    const pix = it.load_icon(exampleName, 48, 0);
                    if (pix) return pix;
                }
                if (exampleName !== 'folder' && it.has_icon('folder')) {
                    const pix = it.load_icon('folder', 48, 0);
                    if (pix) return pix;
                }
            } catch (e) {}
        }

        // 3. Резерв: folder из системной темы GTK по умолчанию.
        try {
            const sys = Gtk.IconTheme.get_default();
            if (sys && sys.has_icon('folder')) {
                const pix = sys.load_icon('folder', 48, 0);
                if (pix) return pix;
            }
        } catch (e) {}

        return null;
    }

    run() {
        const response = this.dialog.run();
        const selectedPaths = [];

        if (response === Gtk.ResponseType.OK) {
            const selection = this.view.get_selection();
            const model = this.store;

            // Число строк верхнего уровня. Модель плоская, iter = null
            // означает "верхний уровень" — это стандартное поведение.
            const n = model.iter_n_children(null);

            for (let i = 0; i < n; i++) {
                // get_iter_from_string в GJS возвращает [ok, iter]
                const [ok, iter] = model.get_iter_from_string(String(i));
                if (!ok || !iter) continue;

                if (!selection.iter_is_selected(iter)) continue;

                const dir = model.get_value(iter, 2);
                if (dir) {
                    selectedPaths.push(
                        GLib.build_filenamev([dir, 'index.theme']));
                }
            }
        }

        this.dialog.destroy();
        return selectedPaths;
    }
}

// =====================================================================
// ГРАФИЧЕСКОЕ ОКНО СРАВНЕНИЯ
// =====================================================================

class GraphicalComparisonWindow {
    constructor(parent, app, iconName) {
        this.app = app;
        this.iconName = iconName;
        this.previewSize = 48;

        this.window = new Gtk.Window({
            title: 'Visual comparison: ' + iconName,
            default_width: 900,
            default_height: 620,
            transient_for: parent,
            modal: false,
            window_position: Gtk.WindowPosition.CENTER
        });

        this.buildUI();
        this.window.show_all();
    }

    rowKeyOf(occ) {
        if (occ.size != null) return String(occ.size);
        if (occ.type) return occ.type;
        return '?';
    }

    rowSortKeyOf(occ) {
        if (occ.size != null) return occ.size;
        return 999999;
    }

    collectSizes(occurrences) {
        const set = new Set();
        for (const occ of occurrences) {
            if (occ.size != null) set.add(occ.size);
        }
        return Array.from(set).sort((a, b) => a - b);
    }

    pickDefaultSize(sizes) {
        if (sizes.length === 0) return 48;
        if (sizes.indexOf(48) >= 0) return 48;
        for (const s of sizes) if (s >= 48) return s;
        return sizes[sizes.length - 1];
    }

    // Выбор превью для верхнего левого угла.
    // Приоритет:
    //   1. Тема по умолчанию из настроек, если она присутствует
    //      среди загруженных в это сравнение (сначала файл, потом симлинк).
    //   2. Любая другая тема — как было раньше (сначала файл, потом симлинк).
    findPreviewPixbuf(occurrences, size) {
        const defTheme = (this.app && this.app.settings)
            ? (this.app.settings.defaultTheme || '')
            : '';

        if (defTheme) {
            // Сопоставление по имени каталога темы (это то, что
            // хранится в настройках), а при отсутствии совпадений —
            // по отображаемому имени (Name= из index.theme).
            let matches = occurrences.filter(occ =>
                occ.theme && GLib.path_get_basename(occ.theme.dir) === defTheme);
            if (matches.length === 0) {
                matches = occurrences.filter(occ =>
                    occ.theme && occ.theme.name === defTheme);
            }

            for (const occ of matches) {
                if (!occ.isSymlink) {
                    const pb = pixbufFromFile(occ.fullPath, size);
                    if (pb) return pb;
                }
            }
            for (const occ of matches) {
                const pb = pixbufFromFile(occ.fullPath, size);
                if (pb) return pb;
            }
        }

        // Fallback — прежнее поведение.
        for (const occ of occurrences) {
            if (!occ.isSymlink) {
                const pb = pixbufFromFile(occ.fullPath, size);
                if (pb) return pb;
            }
        }
        for (const occ of occurrences) {
            const pb = pixbufFromFile(occ.fullPath, size);
            if (pb) return pb;
        }

        return null;
    }

    buildUI() {
        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 8
        });

        let entry = this.app.iconIndex.get(this.iconName);
        let occurrences = entry ? entry.occurrences : [];
        this.occurrences = occurrences;

        // ---------- Шапка ----------
        let header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });

        let preview = new Gtk.Image();
        preview.set_size_request(64, 64);
        preview.set_from_pixbuf(this.findPreviewPixbuf(occurrences, 64));
        header.pack_start(preview, false, false, 0);

        let themesCount = this.app.themes.length;
        let hdrLabel = new Gtk.Label({
            label: '<b>' + escapeMarkup(this.iconName) + '</b>\n' +
                   'Rows = size, Columns = theme (' + themesCount + ')',
            use_markup: true,
            halign: Gtk.Align.START
        });
        header.pack_start(hdrLabel, false, false, 0);

        // Список размеров превью в таблице — справа от имени.
        const sizes = this.collectSizes(occurrences);
        if (sizes.length === 0) sizes.push(48);
        this.previewSize = this.pickDefaultSize(sizes);

        // Editable combo: можно выбрать из списка или ввести вручную.
        this.sizeCombo = Gtk.ComboBoxText.new_with_entry();
        for (const s of sizes) this.sizeCombo.append_text(String(s));

        let activeIdx = sizes.indexOf(this.previewSize);
        if (activeIdx < 0) activeIdx = 0;
        this.sizeCombo.set_active(activeIdx);

        // Настраиваем встроенный entry — ширину и поведение.
        this.sizeEntry = this.sizeCombo.get_child();
        if (this.sizeEntry) {
            this.sizeEntry.set_width_chars(5);
            this.sizeEntry.set_max_length(6);
        }

        this.sizeCombo.set_tooltip_text(
            'Size of the icons shown in the table (select or type a number)');
        this.sizeCombo.connect('changed', () => {
            // При редактировании entry — берём текст из него;
            // при выборе из списка — из active_text.
            let t = null;
            if (this.sizeEntry) t = this.sizeEntry.get_text();
            if (!t) t = this.sizeCombo.get_active_text();
            if (!t) return;

            const v = parseInt(t, 10);
            if (!isNaN(v) && v > 0 && v <= 1024 && v !== this.previewSize) {
                this.previewSize = v;
                this.fillStore();
            }
        });

        // pack_end кладёт первый виджет в самый конец.
        // Сначала комбо (окажется правее), потом метку (слева от него).
        header.pack_end(this.sizeCombo, false, false, 0);

        let sizeLabel = new Gtk.Label({
            label: 'Preview size:',
            halign: Gtk.Align.END
        });
        header.pack_end(sizeLabel, false, false, 0);

        mainBox.pack_start(header, false, false, 0);

        if (themesCount === 0 || occurrences.length === 0) {
            let empty = new Gtk.Label({
                label: '<i>No themes loaded, or icon not found in any theme.</i>',
                use_markup: true,
                halign: Gtk.Align.START
            });
            mainBox.pack_start(empty, false, false, 0);
            this.window.add(mainBox);
            return;
        }

        // ---------- Строки (уникальные размеры) ----------
        this.rowMap = new Map();
        for (let i = 0; i < occurrences.length; i++) {
            let key = this.rowKeyOf(occurrences[i]);
            if (!this.rowMap.has(key)) {
                this.rowMap.set(key, this.rowSortKeyOf(occurrences[i]));
            }
        }
        this.rows = Array.from(this.rowMap.keys());
        this.rows.sort((a, b) => {
            let ka = this.rowMap.get(a);
            let kb = this.rowMap.get(b);
            if (ka !== kb) return ka - kb;
            return a.localeCompare(b);
        });

        // ---------- Модель ----------
        let colTypes = [GObject.TYPE_STRING, GObject.TYPE_INT];
        for (let i = 0; i < themesCount; i++) {
            colTypes.push(GdkPixbuf.Pixbuf);
            colTypes.push(GObject.TYPE_STRING);
            colTypes.push(GObject.TYPE_STRING);
        }
        this.store = new Gtk.ListStore();
        this.store.set_column_types(colTypes);

        // ---------- TreeView ----------
        this.view = new Gtk.TreeView({
            model: this.store,
            headers_clickable: true
        });

        let sizeR = new Gtk.CellRendererText();
        sizeR.set_property('xpad', 6);
        let sizeC = new Gtk.TreeViewColumn({ title: 'Size' });
        sizeC.pack_start(sizeR, true);
        sizeC.add_attribute(sizeR, 'text', 0);
        sizeC.set_min_width(60);
        sizeC.set_resizable(true);
        sizeC.set_expand(true);
        sizeC.set_sort_column_id(1);
        sizeC.set_clickable(true);
        this.view.append_column(sizeC);

        for (let ti = 0; ti < this.app.themes.length; ti++) {
            let pixIdx = 2 + ti * 3;
            let bgIdx  = 3 + ti * 3;

            let r = new Gtk.CellRendererPixbuf();
            r.set_property('xpad', 4);
            r.set_property('ypad', 2);

            let title = this.app.themes[ti].name;
            if (title.length > 18) title = title.substring(0, 17) + '…';

            let c = new Gtk.TreeViewColumn({ title: title });
            c.pack_start(r, false);
            c.add_attribute(r, 'pixbuf', pixIdx);
            c.add_attribute(r, 'cell-background', bgIdx);
            c.set_min_width(56);
            c.set_resizable(true);
            this.view.append_column(c);
        }

        this.store.set_sort_column_id(1, Gtk.SortType.ASCENDING);

        this.fillStore();

        let scroll = new Gtk.ScrolledWindow();
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        scroll.add(this.view);
        mainBox.pack_start(scroll, true, true, 0);

        let legend = new Gtk.Label({
            label: '<small>White = file, blue = symlink, gray = missing</small>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        mainBox.pack_start(legend, false, false, 0);

        let btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });
        btnBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);
        let closeBtn = new Gtk.Button({ label: 'Close' });
        closeBtn.connect('clicked', () => this.window.destroy());
        btnBox.pack_start(closeBtn, false, false, 0);
        mainBox.pack_start(btnBox, false, false, 0);

        this.window.add(mainBox);
    }

    fillStore() {
        this.store.clear();

        const occurrences = this.occurrences;
        const size = this.previewSize;
        const self = this;

        for (let ri = 0; ri < this.rows.length; ri++) {
            let sz = this.rows[ri];
            let rowData = [sz, this.rowMap.get(sz)];

            for (let ti = 0; ti < this.app.themes.length; ti++) {
                let theme = this.app.themes[ti];
                let match = null;

                for (let oi = 0; oi < occurrences.length; oi++) {
                    let occ = occurrences[oi];
                    if (occ.theme !== theme) continue;
                    if (self.rowKeyOf(occ) !== sz) continue;
                    match = occ;
                    break;
                }

                if (match) {
                    let pix = pixbufFromFile(match.fullPath, size);
                    let bg = match.isSymlink ? '#D9E6F2' : '#FFFFFF';
                    rowData.push(pix || getTransparentPixbuf());
                    rowData.push(bg);
                    rowData.push(match.isSymlink ? 'symlink' : 'file');
                } else {
                    rowData.push(getTransparentPixbuf());
                    rowData.push('#F0F0F0');
                    rowData.push('');
                }
            }

            let iter = this.store.append();
            let idx = [];
            for (let k = 0; k < rowData.length; k++) idx.push(k);
            this.store.set(iter, idx, rowData);
        }
    }
}

// =====================================================================
// ОКНО ТЕКСТОВОГО СРАВНЕНИЯ
// =====================================================================

class ComparisonWindow {
    constructor(parent, iconName, occurrences) {
        this.iconName = iconName;
        this.occurrences = occurrences;

        this.window = new Gtk.Window({
            title: 'Comparison: ' + iconName,
            default_width: 950,
            default_height: 520,
            transient_for: parent,
            modal: false,
            window_position: Gtk.WindowPosition.CENTER
        });

        this.buildUI();
        this.window.show_all();
    }

    buildUI() {
        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 8
        });

        let header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });

        let preview = new Gtk.Image();
        preview.set_size_request(64, 64);
        let pixbuf = null;
        for (let i = 0; i < this.occurrences.length; i++) {
            let occ = this.occurrences[i];
            if (!occ.isSymlink) {
                pixbuf = pixbufFromFile(occ.fullPath, 64);
                if (pixbuf) break;
            }
        }
        if (!pixbuf) {
            for (let i = 0; i < this.occurrences.length; i++) {
                pixbuf = pixbufFromFile(this.occurrences[i].fullPath, 64);
                if (pixbuf) break;
            }
        }
        preview.set_from_pixbuf(pixbuf);
        header.pack_start(preview, false, false, 0);

        let themeNames = [];
        let themeSeen = {};
        for (let i = 0; i < this.occurrences.length; i++) {
            let n = this.occurrences[i].theme.name;
            if (!themeSeen[n]) { themeSeen[n] = true; themeNames.push(n); }
        }

        let hdrLabel = new Gtk.Label({
            label: '<b>' + escapeMarkup(this.iconName) + '</b>\n' +
                   this.occurrences.length + ' file(s) in ' + themeNames.length + ' theme(s): ' +
                   escapeMarkup(themeNames.join(', ')),
            use_markup: true,
            halign: Gtk.Align.START
        });
        header.pack_start(hdrLabel, false, false, 0);

        mainBox.pack_start(header, false, false, 0);

        let store = new Gtk.ListStore();
        store.set_column_types([
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING
        ]);

        let view = new Gtk.TreeView({ model: store, headers_clickable: true });

        let cols = [
            ['Theme',    0, false, 120],
            ['Directory',1, true,  180],
            ['Context',  2, false, 100],
            ['Size',     3, false, 60],
            ['Type',     4, false, 80],
            ['Target',   5, true,  200],
            ['Full path',6, true,  300],
            ['Refs',     7, false, 50]
        ];

        for (let i = 0; i < cols.length; i++) {
            let title = cols[i][0], idx = cols[i][1], expand = cols[i][2], minw = cols[i][3];
            let r = new Gtk.CellRendererText();
            r.set_property('ellipsize', 3);
            let c = new Gtk.TreeViewColumn({ title: title });
            c.pack_start(r, true);
            c.add_attribute(r, 'text', idx);
            c.set_resizable(true);
            c.set_expand(expand);
            c.set_min_width(minw);
            c.set_sort_column_id(idx);
            c.set_clickable(true);
            view.append_column(c);
        }

        store.set_sort_column_id(0, Gtk.SortType.ASCENDING);

        for (let i = 0; i < this.occurrences.length; i++) {
            let occ = this.occurrences[i];
            let iter = store.append();
            store.set(iter, [0, 1, 2, 3, 4, 5, 6, 7], [
                occ.theme.name,
                occ.relPath,
                occ.context || '',
                occ.size != null ? String(occ.size) : '',
                occ.isSymlink ? 'symlink' : 'file',
                occ.target || '',
                occ.fullPath,
                ''
            ]);
        }

        let scroll = new Gtk.ScrolledWindow();
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        scroll.add(view);
        mainBox.pack_start(scroll, true, true, 0);

        let btnBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });
        btnBox.pack_start(new Gtk.Label({ label: '' }), true, true, 0);
        let closeBtn = new Gtk.Button({ label: 'Close' });
        closeBtn.connect('clicked', () => this.window.destroy());
        btnBox.pack_start(closeBtn, false, false, 0);
        mainBox.pack_start(btnBox, false, false, 0);

        this.window.add(mainBox);
    }
}

// =====================================================================
// ГЛАВНОЕ ОКНО
// =====================================================================

class MainApp {
    constructor() {
        this.themes = [];
        this.iconIndex = new Map();
        this.filteredNames = [];
        this.currentName = null;
        this.filterTimer = null;
        this.viewMode = 'All';
        this.settings = new Settings();

        // Кэш текущего состояния фильтра для visible_func
        // (читаем его на каждой строке — из виджетов читать дорого).
        this.currentFilterText = '';
        this.currentModeBit = 0;

        // Ссылка на функцию, чтобы GC её не съел.
        this._visibleFunc = null;

        // Битовая маска режима — см. VIEW_MODE_BITS.
        this.viewModeBits = {
            'All': 0,
            'Originals': 1,
            'Originals (strict)': 2,
            'Mixed': 4,
            'Mixed (strict)': 8,
            'Symlinks only': 16
        };

        // Состояние визуальной вкладки в правой панели.
        this.visualPreviewSize = 48;
        this.visualThemeCount = -1;
        this.visualOccurrences = [];
        this.visualRows = [];
        this.visualRowMap = new Map();

        this.buildUI();
    }

    buildUI() {
        this.window = new Gtk.Window({
            title: 'Icon Theme Comparer',
            default_width: 1150,
            default_height: 650,
            window_position: Gtk.WindowPosition.CENTER
        });
        this.window.connect('destroy', () => Gtk.main_quit());

        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 4,
            margin: 5
        });

        let toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });

        let addBtn = new Gtk.Button({ label: 'Add Theme...' });
        addBtn.set_tooltip_text('Add an icon theme (select its directory or index.theme file)');
        addBtn.connect('clicked', () => this.onAddTheme());
        toolbar.pack_start(addBtn, false, false, 0);

        let addSysBtn = new Gtk.Button({ label: 'Add system theme' });
        addSysBtn.set_tooltip_text('Browse and add installed system icon themes');
        addSysBtn.connect('clicked', () => this.onAddSystemThemes());
        toolbar.pack_start(addSysBtn, false, false, 0);

        let removeBtn = new Gtk.Button({ label: 'Remove Theme...' });
        removeBtn.set_tooltip_text('Remove a theme from the comparison');
        removeBtn.connect('clicked', () => this.onRemoveTheme());
        toolbar.pack_start(removeBtn, false, false, 0);

        let refreshBtn = new Gtk.Button({ label: 'Refresh All' });
        refreshBtn.set_tooltip_text('Re-read all loaded themes from disk');
        refreshBtn.connect('clicked', () => this.onRefreshAll());
        toolbar.pack_start(refreshBtn, false, false, 0);

        toolbar.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

        toolbar.pack_start(new Gtk.Label({ label: 'Filter:' }), false, false, 0);
        this.filterEntry = new Gtk.Entry({
            placeholder_text: 'Type text to filter...',
            width_chars: 30
        });
        this.filterEntry.connect('changed', () => this.onFilterChanged());
        toolbar.pack_start(this.filterEntry, false, false, 0);

        // Кнопка настроек (шестерёнка) в правом верхнем углу панели.
        this.settingsBtn = new Gtk.Button();
        try {
            this.settingsBtn.set_image(Gtk.Image.new_from_icon_name(
                'preferences-system', Gtk.IconSize.BUTTON));
        } catch (e) {
            this.settingsBtn.set_label('\u2699'); // ⚙
        }
        this.settingsBtn.set_tooltip_text('Settings');
        this.settingsBtn.set_relief(Gtk.ReliefStyle.NONE);
        this.settingsBtn.connect('clicked', () => this.onSettings());
        toolbar.pack_end(this.settingsBtn, false, false, 0);

        mainBox.pack_start(toolbar, false, false, 0);

        this.themesBar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        let themesScroll = new Gtk.ScrolledWindow();
        themesScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER);
        themesScroll.set_size_request(-1, 44);
        themesScroll.add(this.themesBar);
        mainBox.pack_start(themesScroll, false, false, 0);

        // Разделяемая панель: пользователь может двигать границу.
        let split = new Gtk.Paned({
            orientation: Gtk.Orientation.HORIZONTAL,
            hexpand: true,
            vexpand: true,
            wide_handle: true
        });
        // Стартовая позиция разделителя.
        split.set_position(600);
        // Запоминаем, чтобы потом можно было сохранить/восстановить.
        this.splitPaned = split;

        let leftBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            width_request: 450
        });

        // Полная модель со всеми значками. Пересобирается только при
        // изменении набора тем, не при вводе текста в фильтр.
        this.masterStore = new Gtk.ListStore();
        this.masterStore.set_column_types([
            GObject.TYPE_STRING, // 0 name
            GObject.TYPE_STRING, // 1 color
            GObject.TYPE_STRING, // 2 coverage
            GObject.TYPE_STRING, // 3 contexts
            GObject.TYPE_STRING, // 4 status
            GObject.TYPE_STRING, // 5 baseName (для лукапа)
            GObject.TYPE_INT     // 6 bitmask режимов
        ]);

        // Модель-фильтр. Дочернюю модель передаём через конструктор
        // с объектом свойств — только так GJS создаёт настоящий
        // Gtk.TreeModelFilter, а не интерфейсную обёртку Gtk.TreeModel
        // (у неё нет ни set_child_model, ни set_visible_func).
        this.filterModel = new Gtk.TreeModelFilter({
            child_model: this.masterStore
        });

        this._visibleFunc = (model, iter) => {
            const name = model.get_value(iter, 0);
            if (this.currentFilterText &&
                name.toLowerCase().indexOf(this.currentFilterText) < 0) {
                return false;
            }
            if (this.currentModeBit !== 0) {
                const flags = model.get_value(iter, 6);
                if (!(flags & this.currentModeBit)) return false;
            }
            return true;
        };

        if (typeof this.filterModel.set_visible_func !== 'function') {
            logError(new Error(
                'Gtk.TreeModelFilter binding problem: ' +
                'got ' + (this.filterModel.constructor && this.filterModel.constructor.name)
            ));
        } else {
            this.filterModel.set_visible_func(this._visibleFunc);
        }

        // Сортировщик поверх фильтра — TreeView требует TreeSortable,
        // а Gtk.TreeModelFilter им не является. Порядок по умолчанию —
        // по колонке 0 (имя), возрастание.
        this.sortModel = new Gtk.TreeModelSort({
            model: this.filterModel
        });
        this.sortModel.set_sort_column_id(0, Gtk.SortType.ASCENDING);

        this.treeView = new Gtk.TreeView({
            model: this.sortModel,
            headers_clickable: true
        });

        let nameR = new Gtk.CellRendererText();
        nameR.set_property('ellipsize', 3);
        let nameC = new Gtk.TreeViewColumn({ title: 'Icons' });
        nameC.pack_start(nameR, true);
        nameC.add_attribute(nameR, 'text', 0);
        nameC.add_attribute(nameR, 'foreground', 1);
        nameC.set_sort_column_id(0);
        nameC.set_expand(true);
        nameC.set_resizable(true);
        nameC.set_min_width(140);
        this.treeView.append_column(nameC);

        let covR = new Gtk.CellRendererText();
        let covC = new Gtk.TreeViewColumn({ title: 'Themes' });
        covC.pack_start(covR, false);
        covC.add_attribute(covR, 'text', 2);
        covC.set_sort_column_id(2);
        covC.set_resizable(true);
        covC.set_min_width(70);
        this.treeView.append_column(covC);

        let ctxR = new Gtk.CellRendererText();
        ctxR.set_property('ellipsize', 3);
        let ctxC = new Gtk.TreeViewColumn({ title: 'Contexts' });
        ctxC.pack_start(ctxR, true);
        ctxC.add_attribute(ctxR, 'text', 3);
        ctxC.set_sort_column_id(3);
        ctxC.set_resizable(true);
        ctxC.set_min_width(140);
        this.treeView.append_column(ctxC);

        let stR = new Gtk.CellRendererText();
        let stC = new Gtk.TreeViewColumn({ title: 'Status' });
        stC.pack_start(stR, false);
        stC.add_attribute(stR, 'text', 4);
        stC.set_sort_column_id(4);
        stC.set_resizable(true);
        stC.set_min_width(130);
        this.treeView.append_column(stC);

        this.treeView.connect('cursor-changed', () => this.onIconSelected());
        this.treeView.connect('row-activated', () => this.onIconActivated());
        this.treeView.connect('button-press-event', (w, e) => this.onTreeRightClick(w, e));

        let listScroll = new Gtk.ScrolledWindow();
        listScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        listScroll.add(this.treeView);
        leftBox.pack_start(listScroll, true, true, 0);

        // leftBox: resize=true (растёт вместе с окном),
        //          shrink=false (не сжимать ниже его минимальной ширины).
        split.pack1(leftBox, true, false);

        // Правая панель
        let rightBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            width_request: 470
        });

        let infoHdr = new Gtk.Label({
            label: '<b>Selected icon</b>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        rightBox.pack_start(infoHdr, false, false, 0);

        // Шапка над ноутбуком: превью, имя, сводка по темам.
        let infoTop = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });
        this.infoImage = new Gtk.Image();
        this.infoImage.set_size_request(64, 64);
        infoTop.pack_start(this.infoImage, false, false, 0);

        this.infoText = new Gtk.Label({
            label: 'None',
            halign: Gtk.Align.START,
            valign: Gtk.Align.START,
            wrap: true,
            use_markup: true,
            width_chars: 40
        });
        infoTop.pack_start(this.infoText, true, true, 0);
        rightBox.pack_start(infoTop, false, false, 0);

        // ----- Notebook с двумя вкладками -----
        this.rightNotebook = new Gtk.Notebook();
        this.rightNotebook.set_scrollable(true);

        // --- Вкладка 1: список файлов/симлинков ---
        let filesTab = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            margin: 4
        });

        this.infoStore = new Gtk.ListStore();
        this.infoStore.set_column_types([
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_STRING,
            GObject.TYPE_INT
        ]);

        this.infoView = new Gtk.TreeView({
            model: this.infoStore,
            headers_clickable: true
        });

        let infoCols = [
            ['Theme',   0, false, 100, 0],
            ['Dir',     1, true,  120, 1],
            ['Context', 2, false, 80,  2],
            ['Size',    3, false, 50,  6],
            ['Type',    4, false, 70,  4],
            ['Target',  5, true,  120, 5]
        ];
        this.infoView.connect('cursor-changed', () => this.onInfoRowSelected());
        for (let i = 0; i < infoCols.length; i++) {
            let title = infoCols[i][0], idx = infoCols[i][1],
                expand = infoCols[i][2], minw = infoCols[i][3],
                sortIdx = infoCols[i][4];
            let r = new Gtk.CellRendererText();
            r.set_property('ellipsize', 3);
            let c = new Gtk.TreeViewColumn({ title: title });
            c.pack_start(r, true);
            c.add_attribute(r, 'text', idx);
            c.set_resizable(true);
            c.set_expand(expand);
            c.set_min_width(minw);
            c.set_sort_column_id(sortIdx);
            c.set_clickable(true);
            this.infoView.append_column(c);
        }
        this.infoStore.set_sort_column_id(0, Gtk.SortType.ASCENDING);

        let infoScroll = new Gtk.ScrolledWindow();
        infoScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        infoScroll.add(this.infoView);
        filesTab.pack_start(infoScroll, true, true, 0);

        let hint = new Gtk.Label({
            label: '<i>Double-click an icon to open the comparison window</i>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        filesTab.pack_start(hint, false, false, 0);

        this.rightNotebook.append_page(filesTab, new Gtk.Label({ label: 'Files' }));

        // --- Вкладка 2: визуальное сравнение (как в GraphicalComparisonWindow) ---
        let visualTab = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 5,
            margin: 4
        });

        this.visualStore = new Gtk.ListStore();
        this.visualView = new Gtk.TreeView({
            model: this.visualStore,
            headers_clickable: true
        });

        let visualScroll = new Gtk.ScrolledWindow();
        visualScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        visualScroll.add(this.visualView);
        visualTab.pack_start(visualScroll, true, true, 0);

        // Нижняя строка визуальной вкладки: "Preview size:" + combo.
        let visualBottom = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 6
        });

        this.visualSizeLabel = new Gtk.Label({
            label: 'Preview size:',
            halign: Gtk.Align.START
        });
        visualBottom.pack_start(this.visualSizeLabel, false, false, 0);

        this.visualSizeCombo = Gtk.ComboBoxText.new_with_entry();
        let vEntry = this.visualSizeCombo.get_child();
        if (vEntry) {
            vEntry.set_width_chars(5);
            vEntry.set_max_length(6);
        }
        this.visualSizeCombo.set_tooltip_text(
            'Size of the icons shown in the table (select or type a number)');
        this.visualSizeCombo.connect('changed', () => {
            let t = null;
            const e = this.visualSizeCombo.get_child();
            if (e) t = e.get_text();
            if (!t) t = this.visualSizeCombo.get_active_text();
            if (!t) return;
            const v = parseInt(t, 10);
            if (!isNaN(v) && v > 0 && v <= 1024 && v !== this.visualPreviewSize) {
                this.visualPreviewSize = v;
                this.fillVisualStore();
            }
        });
        visualBottom.pack_start(this.visualSizeCombo, false, false, 0);
        visualBottom.pack_start(new Gtk.Label({ label: '' }), true, true, 0);

        visualTab.pack_start(visualBottom, false, false, 0);

        this.rightNotebook.append_page(visualTab, new Gtk.Label({ label: 'Visual' }));

        // При переключении вкладки — обновляем содержимое видимой.
        this.rightNotebook.connect('switch-page', (nb, page, pageNum) => {
            this.refreshRightTabs(pageNum);
        });

        rightBox.pack_start(this.rightNotebook, true, true, 0);

        // rightBox: resize=false — при растягивании окна
        //           дополнительная ширина уходит в левую панель;
        //           shrink=false — не сжимать ниже минимальной ширины.
        split.pack2(rightBox, false, false);

        mainBox.pack_start(split, true, true, 0);

        this.statusBox = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });

        // Первичный фильтр по характеру записей (файлы / симлинки / смесь).
        let viewLbl = new Gtk.Label({
            label: 'Show:',
            halign: Gtk.Align.START,
            margin_start: 4
        });
        this.statusBox.pack_start(viewLbl, false, false, 0);

        this.viewModeCombo = new Gtk.ComboBoxText();
        this.viewModeCombo.append_text('All');
        this.viewModeCombo.append_text('Originals');
        this.viewModeCombo.append_text('Originals (strict)');
        this.viewModeCombo.append_text('Mixed');
        this.viewModeCombo.append_text('Mixed (strict)');
        this.viewModeCombo.append_text('Symlinks only');
        this.viewModeCombo.set_active(0);
        this.viewModeCombo.set_tooltip_text(
            'Pre-filter icon names before applying the text filter.\n' +
            '\n' +
            'All — show every icon name.\n' +
            '\n' +
            'Originals — name is a regular file (not a symlink)\n' +
            'in at least one theme.\n' +
            '\n' +
            'Originals (strict) — name is a regular file in every\n' +
            'theme where it appears; no symlinks at all.\n' +
            '\n' +
            'Mixed — name appears both as file and as symlink\n' +
            'somewhere, but no theme has it as files only.\n' +
            '\n' +
            'Mixed (strict) — every theme that contains the name\n' +
            'has a mix of files and symlinks; no theme has it as\n' +
            'files only or as symlinks only. Useful to spot themes\n' +
            'that are not fully converted.\n' +
            '\n' +
            'Symlinks only — name is a symlink in every theme\n' +
            'where it appears; no regular files at all.'
        );
        this.viewModeCombo.connect('changed', () => {
            this.viewMode = this.viewModeCombo.get_active_text() || 'All';
            this.refilterList();
        });
        this.statusBox.pack_start(this.viewModeCombo, false, false, 0);

        this.statusLabel = new Gtk.Label({
            label: '',
            halign: Gtk.Align.START,
            margin_start: 8
        });
        this.statusBox.pack_start(this.statusLabel, false, false, 0);

        mainBox.pack_start(this.statusBox, false, false, 0);

        this.window.add(mainBox);
        this.window.show_all();

        this.updateThemesBar();
        this.updateStatus();
    }

    setStatus(msg) {
        this.statusLabel.set_text(msg);
    }

    updateStatus() {
        const total = this.iconIndex.size;
        let visible = total;
        try {
            if (this.filterModel) {
                visible = this.filterModel.iter_n_children(null);
            }
        } catch (e) {}
        let s = this.themes.length + ' theme(s) loaded, ' +
                total + ' unique icon name(s)';
        if (visible !== total) s += ', ' + visible + ' shown';
        this.setStatus(s);
    }

    updateThemesBar() {
        let children = this.themesBar.get_children();
        for (let i = 0; i < children.length; i++) children[i].destroy();

        if (this.themes.length === 0) {
            let lbl = new Gtk.Label({
                label: '<i>No themes loaded — click "Add Theme..."</i>',
                use_markup: true,
                halign: Gtk.Align.START,
                margin: 5
            });
            this.themesBar.pack_start(lbl, false, false, 0);
        } else {
            for (let i = 0; i < this.themes.length; i++) {
                let t = this.themes[i];
                let frame = new Gtk.Frame();
                let box = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 2 });
                let lbl = new Gtk.Label({
                    label: escapeMarkup(t.name),
                    use_markup: true,
                    tooltip_text: t.indexPath,
                    margin_start: 4,
                    margin_end: 2
                });
                box.pack_start(lbl, false, false, 0);
                let xBtn = new Gtk.Button({ label: '×' });
                xBtn.set_relief(Gtk.ReliefStyle.NONE);
                xBtn.set_tooltip_text('Remove this theme');
                xBtn.connect('clicked', () => {
                    this.themes = this.themes.filter(function(x) { return x !== t; });
                    this.rebuildIndex();
                    this.updateThemesBar();
                    this.populateMasterStore();
                    this.updateStatus();
                });
                box.pack_start(xBtn, false, false, 0);
                frame.add(box);
                this.themesBar.pack_start(frame, false, false, 0);
            }
        }

        this.themesBar.show_all();
    }

    onAddTheme() {
        let dialog = new Gtk.FileChooserDialog({
            title: 'Select icon theme directory',
            action: Gtk.FileChooserAction.SELECT_FOLDER,
            transient_for: this.window,
            modal: true
        });
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Add', Gtk.ResponseType.OK);

        let response = dialog.run();
        let path = (response === Gtk.ResponseType.OK) ? dialog.get_filename() : null;
        dialog.destroy();

        if (path) {
            this.loadThemesWithProgress([path]);
        }
    }

    onAddSystemThemes() {
        const dlg = new SystemThemesDialog(this.window, this);
        const selectedPaths = dlg.run();
        if (selectedPaths && selectedPaths.length > 0) {
            this.loadThemesWithProgress(selectedPaths);
        }
    }

    // Загружает одну или несколько тем последовательно, показывая
    // модальный диалог прогресса с кнопкой Cancel. Для одиночной
    // быстрой темы диалог просто мелькнёт.
    async loadThemesWithProgress(paths) {
        const n = paths.length;
        const title = (n === 1) ? 'Loading theme' : 'Loading themes';
        const text = (n === 1)
            ? 'Loading ' + GLib.path_get_basename(GLib.path_get_dirname(paths[0]))
            : 'Loading ' + n + ' theme(s)...';

        const progress = new ProgressDialog(this.window, title, text);

        // Пока идёт загрузка, не запускаем фильтр на каждый добавленный
        // шаг — сделаем один раз в конце, после закрытия прогресса загрузки.
        try {
            for (let i = 0; i < n; i++) {
                if (progress.isCancelled()) break;
                const name = GLib.path_get_basename(
                    GLib.path_get_dirname(paths[i]));
                progress.setStatus(i / n,
                    (n > 1 ? ('(' + (i + 1) + '/' + n + ') ') : '') +
                    'Loading ' + name + '...');
                await this.addThemeByPath(paths[i], progress);
            }
        } catch (e) {
            // уже показали ошибку или отменено — просто закрываем
        } finally {
            progress.close();
        }

        // Один итоговый проход фильтра. Для тяжёлых наборов он сам
        // покажет диалог прогресса — уже с кнопкой Cancel.
        this.populateMasterStore();
    }

    async addThemeByPath(path, progress) {
        let file = Gio.File.new_for_path(path);
        let info;
        try {
            info = await file.query_info_async('standard::type',
                Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            if (!progress) this.showError('Cannot access:\n' + path);
            return false;
        }

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            let indexPath = GLib.build_filenamev([path, 'index.theme']);
            if (!Gio.File.new_for_path(indexPath).query_exists(null)) {
                if (!progress) this.showError('Directory does not contain index.theme:\n' + path);
                return false;
            }
            path = indexPath;
        } else if (GLib.path_get_basename(path) !== 'index.theme') {
            if (!progress) this.showError('Expected index.theme (or a directory containing one).\nGot:\n' + path);
            return false;
        }

        for (let i = 0; i < this.themes.length; i++) {
            if (this.themes[i].indexPath === path) {
                if (!progress) this.showError('Theme already loaded:\n' + path);
                return false;
            }
        }

        let theme = new IconTheme(path);
        const ok = await theme.load(progress);

        if (progress && progress.isCancelled()) {
            return false;
        }

        if (!ok) {
            this.showError('Failed to load theme:\n' + (theme.error || 'unknown error'));
            return false;
        }

        this.themes.push(theme);
        this.rebuildIndex();
        this.updateThemesBar();
        this.populateMasterStore();
        return true;
    }

    onRemoveTheme() {
        if (this.themes.length === 0) {
            this.showError('No themes loaded.');
            return;
        }

        let dialog = new Gtk.Dialog({
            title: 'Remove theme',
            transient_for: this.window,
            modal: true
        });
        dialog.add_button('Cancel', Gtk.ResponseType.CANCEL);
        dialog.add_button('Remove', Gtk.ResponseType.OK);

        let content = dialog.get_content_area();
        content.set_spacing(5);
        content.set_margin_start(10);
        content.set_margin_end(10);
        content.set_margin_top(10);
        content.set_margin_bottom(10);

        content.pack_start(new Gtk.Label({
            label: 'Select a theme to remove:',
            halign: Gtk.Align.START
        }), false, false, 0);

        let store = new Gtk.ListStore();
        store.set_column_types([GObject.TYPE_STRING, GObject.TYPE_STRING]);
        for (let i = 0; i < this.themes.length; i++) {
            let iter = store.append();
            store.set(iter, [0, 1], [this.themes[i].name, this.themes[i].indexPath]);
        }

        let view = new Gtk.TreeView({ model: store });
        let r1 = new Gtk.CellRendererText();
        let c1 = new Gtk.TreeViewColumn({ title: 'Name' });
        c1.pack_start(r1, true);
        c1.add_attribute(r1, 'text', 0);
        view.append_column(c1);
        let r2 = new Gtk.CellRendererText();
        let c2 = new Gtk.TreeViewColumn({ title: 'Path' });
        c2.pack_start(r2, true);
        c2.add_attribute(r2, 'text', 1);
        view.append_column(c2);

        let scroll = new Gtk.ScrolledWindow();
        scroll.set_size_request(450, 220);
        scroll.add(view);
        content.pack_start(scroll, true, true, 0);

        dialog.show_all();
        let response = dialog.run();

        if (response === Gtk.ResponseType.OK) {
            let [ok, model, iter] = view.get_selection().get_selected();
            if (ok) {
                let idxPath = model.get_value(iter, 1);
                this.themes = this.themes.filter(function(t) { return t.indexPath !== idxPath; });
                this.rebuildIndex();
                this.updateThemesBar();
                this.populateMasterStore();
                this.updateStatus();
            }
        }
        dialog.destroy();
    }

    async onRefreshAll() {
        for (let i = 0; i < this.themes.length; i++) {
            let t = this.themes[i];
            t.icons.clear();
            t.directories.clear();
            t.directoryList = [];
            t._loaded = false;
            await t.load();
        }
        this.rebuildIndex();
        this.populateMasterStore();
        this.updateStatus();
    }

    onSettings() {
        const dlg = new SettingsDialog(this.window, this.settings, () => {
            // Настройки изменились — обновляем цвета в списке значков.
            this.populateMasterStore();
        });
        dlg.run();
    }

    rebuildIndex() {
        this.iconIndex.clear();

        for (let ti = 0; ti < this.themes.length; ti++) {
            let theme = this.themes[ti];
            for (let [name, data] of theme.icons) {
                if (!this.iconIndex.has(name)) {
                    this.iconIndex.set(name, {
                        name: name,
                        occurrences: [],
                        themes: new Set(),
                        contexts: new Set()
                    });
                }
                let entry = this.iconIndex.get(name);
                for (let oi = 0; oi < data.occurrences.length; oi++) {
                    let occ = data.occurrences[oi];
                    entry.occurrences.push(occ);
                    entry.themes.add(theme);
                    if (occ.context) entry.contexts.add(occ.context);
                }
            }
        }
        // Темы могли измениться — на следующем обновлении визуальной
        // вкладки колонки будут пересозданы.
        this.visualThemeCount = -1;
    }

    onFilterChanged() {
        // refilter() дёшев: просто перебор строк без аллокаций.
        // Debounce не нужен — вызываем сразу при каждом нажатии.
        this.refilterList();
    }

    // Пересборка полной модели. Вызывается только при изменении
    // набора тем (добавление, удаление, refresh) и при смене настроек.
    populateMasterStore() {
        this.masterStore.clear();
        const totalThemes = this.themes.length;

        for (const [name, entry] of this.iconIndex) {
            const iter = this.masterStore.append();

            const coverage = entry.themes.size + '/' + totalThemes;
            let contextsStr;
            if (entry.contexts.size > 1) contextsStr = 'Multiple';
            else if (entry.contexts.size === 1) {
                contextsStr = entry.contexts.values().next().value;
            } else contextsStr = '';

            let symlinkCount = 0;
            for (let oi = 0; oi < entry.occurrences.length; oi++) {
                if (entry.occurrences[oi].isSymlink) symlinkCount++;
            }

            let status, color;
            if (entry.themes.size < totalThemes) {
                color = this.settings.colors.missing;
                status = 'Missing in ' + (totalThemes - entry.themes.size);
            } else if (symlinkCount === entry.occurrences.length) {
                color = this.settings.colors.symlinksOnly;
                status = 'Symlinks only';
            } else if (symlinkCount > 0) {
                color = this.settings.colors.hasSymlinks;
                status = 'Has symlinks';
            } else {
                color = this.settings.colors.ok;
                status = 'OK';
            }

            this.masterStore.set(iter, [0, 1, 2, 3, 4, 5, 6], [
                name, color, coverage, contextsStr, status, name,
                this.computeModeFlags(entry)
            ]);
        }

        this.refilterList();
    }

    // Мгновенное применение текущего текста фильтра и режима.
    // Не пересобирает модель — только пересчитывает видимость строк.
    refilterList() {
        if (this.filterEntry) {
            this.currentFilterText =
                this.filterEntry.get_text().toLowerCase();
        }
        if (this.viewModeCombo) {
            const t = this.viewModeCombo.get_active_text() || 'All';
            this.currentModeBit = this.viewModeBits[t] || 0;
        }
        if (this.filterModel) {
            this.filterModel.refilter();
        }
        this.updateStatus();
    }

    // Упаковка классификации значка в один int — чтобы visible_func
    // на каждой строке читала одно число, а не пересчитывала всё заново.
    computeModeFlags(entry) {
        const info = this.classifyEntry(entry);
        let flags = 0;
        if (info.anyFileOnly) flags |= 1;
        if (info.allFileOnly) flags |= 2;
        if (info.hasFileOverall && info.hasSymlinkOverall &&
            !info.anyFileOnly) flags |= 4;
        if (info.hasFileOverall && info.hasSymlinkOverall &&
            !info.anyFileOnly && !info.anySymlinkOnly) flags |= 8;
        if (info.allSymlinkOnly) flags |= 16;
        return flags;
    }

    // Классифицирует записи значка по темам:
    //   - anyFileOnly     — есть хотя бы одна тема, где значок только файлами;
    //   - allFileOnly     — во всех темах, где значок есть, он только файлами;
    //   - anySymlinkOnly  — есть хотя бы одна тема, где значок только симлинками;
    //   - allSymlinkOnly  — во всех темах, где значок есть, он только симлинками;
    //   - hasFileOverall / hasSymlinkOverall — есть ли в принципе файлы/симлинки.
    classifyEntry(entry) {
        if (entry._cls) return entry._cls;
        const perTheme = new Map();
        let hasFileOverall = false;
        let hasSymlinkOverall = false;

        for (let i = 0; i < entry.occurrences.length; i++) {
            const occ = entry.occurrences[i];
            let c = perTheme.get(occ.theme);
            if (!c) {
                c = { hasFile: false, hasSymlink: false };
                perTheme.set(occ.theme, c);
            }
            if (occ.isSymlink) {
                c.hasSymlink = true;
                hasSymlinkOverall = true;
            } else {
                c.hasFile = true;
                hasFileOverall = true;
            }
        }

        let anyFileOnly = false;
        let anySymlinkOnly = false;
        let allFileOnly = perTheme.size > 0;
        let allSymlinkOnly = perTheme.size > 0;

        for (const c of perTheme.values()) {
            if (c.hasFile && c.hasSymlink) {
                allFileOnly = false;
                allSymlinkOnly = false;
            } else if (c.hasFile) {
                anyFileOnly = true;
                allSymlinkOnly = false;
            } else {
                anySymlinkOnly = true;
                allFileOnly = false;
            }
        }

        const result = {
            hasFileOverall: hasFileOverall,
            hasSymlinkOverall: hasSymlinkOverall,
            anyFileOnly: anyFileOnly,
            anySymlinkOnly: anySymlinkOnly,
            allFileOnly: allFileOnly,
            allSymlinkOnly: allSymlinkOnly
        };
        entry._cls = result;
        return result;
    }

    matchesViewMode(entry, mode) {
        const info = this.classifyEntry(entry);
        switch (mode) {
            case 'Originals':
                // Имя файлами-не-симлинками хотя бы в одной теме.
                return info.anyFileOnly;

            case 'Originals (strict)':
                // Во всех темах, где имя есть, оно представлено только файлами.
                return info.allFileOnly;

            case 'Mixed':
                // Есть и файлы, и симлинки, но ни в одной теме
                // оно не представлено только файлами.
                return info.hasFileOverall
                    && info.hasSymlinkOverall
                    && !info.anyFileOnly;

            case 'Mixed (strict)':
                // Ни в одной теме оно не представлено ни только файлами,
                // ни только симлинками. То есть каждая тема, где оно есть,
                // содержит его как смесь.
                return info.hasFileOverall
                    && info.hasSymlinkOverall
                    && !info.anyFileOnly
                    && !info.anySymlinkOnly;

            case 'Symlinks only':
                // Во всех темах, где имя есть, оно представлено только симлинками.
                return info.allSymlinkOnly;

            case 'All':
            default:
                return true;
        }
    }

    onIconSelected() {
        let [ok, model, iter] = this.treeView.get_selection().get_selected();
        if (!ok || !iter) return;

        let name = model.get_value(iter, 5);
        if (!name) return;

        if (name === this.currentName) return;
        this.currentName = name;

        this.showIconInfo(name);
    }

    showIconInfo(name) {
        let entry = this.iconIndex.get(name);
        if (!entry) return;

        // ----- Верхняя часть: превью + имя + сводка -----
        let previewPixbuf = null;
        for (let i = 0; i < entry.occurrences.length; i++) {
            let occ = entry.occurrences[i];
            if (!occ.isSymlink) {
                previewPixbuf = pixbufFromFile(occ.fullPath, 64);
                if (previewPixbuf) break;
            }
        }
        if (!previewPixbuf) {
            for (let i = 0; i < entry.occurrences.length; i++) {
                previewPixbuf = pixbufFromFile(entry.occurrences[i].fullPath, 64);
                if (previewPixbuf) break;
            }
        }
        this.infoImage.set_from_pixbuf(previewPixbuf);

        let themeNames = [];
        for (let t of entry.themes) themeNames.push(t.name);
        themeNames.sort();

        let symlinkCount = 0;
        for (let i = 0; i < entry.occurrences.length; i++) {
            if (entry.occurrences[i].isSymlink) symlinkCount++;
        }
        let fileCount = entry.occurrences.length - symlinkCount;

        let infoText = '<b>' + escapeMarkup(name) + '</b>\n';
        infoText += 'Themes: ' + escapeMarkup(themeNames.join(', ')) + '\n';
        infoText += 'Files: ' + fileCount + ', Symlinks: ' + symlinkCount;

        // Контексты, в которых встречается имя — уникальные, по алфавиту.
        let contextsArr = Array.from(entry.contexts).filter(Boolean).sort();
        let contextsStr = contextsArr.length ? contextsArr.join(', ') : '(none)';
        infoText += '\nContext(s): ' + escapeMarkup(contextsStr);

        this.infoText.set_markup(infoText);

        // ----- Обновляем активную вкладку -----
        const pageNum = this.rightNotebook.get_current_page();
        if (pageNum === 0) {
            this.populateInfoStore(name);
        } else if (pageNum === 1) {
            this.refreshVisualTab();
        }
    }

    // Заполнение первой вкладки (список файлов/симлинков).
    populateInfoStore(name) {
        let entry = this.iconIndex.get(name);
        if (!entry) return;

        this.infoStore.clear();

        for (let i = 0; i < entry.occurrences.length; i++) {
            let occ = entry.occurrences[i];
            let sizeText = occ.size != null ? String(occ.size) : '';
            let sizeKey;
            if (occ.size != null) sizeKey = occ.size;
            else if (occ.type) sizeKey = 999999;
            else sizeKey = -1;

            let iter = this.infoStore.append();
            this.infoStore.set(iter, [0, 1, 2, 3, 4, 5, 6], [
                occ.theme.name,
                occ.relPath,
                occ.context || '',
                sizeText,
                occ.isSymlink ? 'symlink' : 'file',
                occ.target || '',
                sizeKey
            ]);
        }

        GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            let iter = this.infoStore.get_iter_first();
            if (iter) {
                let path = new Gtk.TreePath();
                path.append_index(0);
                this.infoView.set_cursor(path, null, false);
            }
            return false;
        });
    }

    // Пересборка колонок визуальной вкладки при изменении набора тем.
    ensureVisualColumns() {
        const themesCount = this.themes.length;
        if (this.visualThemeCount === themesCount) return;

        // Пересоздаём модель: количество колонок зависит от числа тем.
        let colTypes = [GObject.TYPE_STRING, GObject.TYPE_INT];
        for (let i = 0; i < themesCount; i++) {
            colTypes.push(GdkPixbuf.Pixbuf);
            colTypes.push(GObject.TYPE_STRING);
            colTypes.push(GObject.TYPE_STRING);
        }
        this.visualStore = new Gtk.ListStore();
        this.visualStore.set_column_types(colTypes);
        this.visualView.set_model(this.visualStore);

        // Убираем старые колонки.
        const oldCols = this.visualView.get_columns();
        for (let i = 0; i < oldCols.length; i++) {
            this.visualView.remove_column(oldCols[i]);
        }

        // Колонка "Size".
        let sizeR = new Gtk.CellRendererText();
        sizeR.set_property('xpad', 4);
        let sizeC = new Gtk.TreeViewColumn({ title: 'Size' });
        sizeC.pack_start(sizeR, true);
        sizeC.add_attribute(sizeR, 'text', 0);
        sizeC.set_min_width(46);
        sizeC.set_resizable(true);
        sizeC.set_sort_column_id(1);
        sizeC.set_clickable(true);
        this.visualView.append_column(sizeC);

        // Колонка на каждую тему.
        for (let ti = 0; ti < themesCount; ti++) {
            let pixIdx = 2 + ti * 3;
            let bgIdx  = 3 + ti * 3;

            let r = new Gtk.CellRendererPixbuf();
            r.set_property('xpad', 3);
            r.set_property('ypad', 2);

            let title = this.themes[ti].name;
            if (title.length > 14) title = title.substring(0, 13) + '…';

            let c = new Gtk.TreeViewColumn({ title: title });
            c.pack_start(r, false);
            c.add_attribute(r, 'pixbuf', pixIdx);
            c.add_attribute(r, 'cell-background', bgIdx);
            c.set_min_width(50);
            c.set_resizable(true);
            this.visualView.append_column(c);
        }

        this.visualStore.set_sort_column_id(1, Gtk.SortType.ASCENDING);
        this.visualThemeCount = themesCount;
    }

    // Полное обновление визуальной вкладки (строки, комбо размера, модель).
    refreshVisualTab() {
        this.ensureVisualColumns();

        const name = this.currentName;
        const entry = name ? this.iconIndex.get(name) : null;
        const occurrences = entry ? entry.occurrences : [];
        this.visualOccurrences = occurrences;

        // Уникальные размеры (строки таблицы).
        const rowMap = new Map();
        for (const occ of occurrences) {
            const key = this.rowKeyOf(occ);
            if (!rowMap.has(key)) rowMap.set(key, this.rowSortKeyOf(occ));
        }
        const rows = Array.from(rowMap.keys()).sort((a, b) => {
            const ka = rowMap.get(a);
            const kb = rowMap.get(b);
            if (ka !== kb) return ka - kb;
            return a.localeCompare(b);
        });
        this.visualRows = rows;
        this.visualRowMap = rowMap;

        // Обновляем ComboBoxText доступными размерами.
        const sizes = this.collectSizes(occurrences);
        if (sizes.length === 0) sizes.push(48);

        // Сохраняем текущий выбор, если он ещё доступен.
        if (sizes.indexOf(this.visualPreviewSize) < 0) {
            this.visualPreviewSize = this.pickDefaultSize(sizes);
        }

        this.visualSizeCombo.remove_all();
        for (const s of sizes) this.visualSizeCombo.append_text(String(s));
        const activeIdx = sizes.indexOf(this.visualPreviewSize);
        if (activeIdx >= 0) {
            this.visualSizeCombo.set_active(activeIdx);
        }

        this.fillVisualStore();
    }

    // Заполнение модели визуальной вкладки текущими данными.
    fillVisualStore() {
        if (!this.visualStore) return;
        this.visualStore.clear();

        const occurrences = this.visualOccurrences || [];
        const rows = this.visualRows || [];
        const size = this.visualPreviewSize;
        const themes = this.themes;
        const self = this;

        for (let ri = 0; ri < rows.length; ri++) {
            const sz = rows[ri];
            const rowData = [sz, this.visualRowMap.get(sz)];

            for (let ti = 0; ti < themes.length; ti++) {
                const theme = themes[ti];
                let match = null;

                for (let oi = 0; oi < occurrences.length; oi++) {
                    const occ = occurrences[oi];
                    if (occ.theme !== theme) continue;
                    if (self.rowKeyOf(occ) !== sz) continue;
                    match = occ;
                    break;
                }

                if (match) {
                    const pix = pixbufFromFile(match.fullPath, size);
                    const bg = match.isSymlink ? '#D9E6F2' : '#FFFFFF';
                    rowData.push(pix || getTransparentPixbuf());
                    rowData.push(bg);
                    rowData.push(match.isSymlink ? 'symlink' : 'file');
                } else {
                    rowData.push(getTransparentPixbuf());
                    rowData.push('#F0F0F0');
                    rowData.push('');
                }
            }

            const iter = this.visualStore.append();
            const idx = [];
            for (let k = 0; k < rowData.length; k++) idx.push(k);
            this.visualStore.set(iter, idx, rowData);
        }
    }

    // Переключение вкладок: обновляем ту, что показана.
    refreshRightTabs(pageNum) {
        if (!this.currentName) return;
        if (pageNum === 0) {
            this.populateInfoStore(this.currentName);
        } else if (pageNum === 1) {
            this.refreshVisualTab();
        }
    }

    // Утилиты, повторяющие логику GraphicalComparisonWindow.
    rowKeyOf(occ) {
        if (occ.size != null) return String(occ.size);
        if (occ.type) return occ.type;
        return '?';
    }

    rowSortKeyOf(occ) {
        if (occ.size != null) return occ.size;
        return 999999;
    }

    collectSizes(occurrences) {
        const set = new Set();
        for (const occ of occurrences) {
            if (occ.size != null) set.add(occ.size);
        }
        return Array.from(set).sort((a, b) => a - b);
    }

    pickDefaultSize(sizes) {
        if (sizes.length === 0) return 48;
        if (sizes.indexOf(48) >= 0) return 48;
        for (const s of sizes) if (s >= 48) return s;
        return sizes[sizes.length - 1];
    }

    onInfoRowSelected() {
        let [ok, model, iter] = this.infoView.get_selection().get_selected();
        if (!ok || !iter) return;

        let relPath = model.get_value(iter, 1);
        if (!relPath) return;

        let entry = this.iconIndex.get(this.currentName);
        if (!entry) return;

        let match = null;
        for (let i = 0; i < entry.occurrences.length; i++) {
            let occ = entry.occurrences[i];
            if (occ.relPath !== relPath) continue;
            let themeName = model.get_value(iter, 0);
            if (occ.theme.name !== themeName) continue;
            match = occ;
            break;
        }

        if (!match) return;

        let pix = pixbufFromFile(match.fullPath, 64);
        this.infoImage.set_from_pixbuf(pix);
    }

    onIconActivated() {
        this.openGraphicalComparison();
    }

    openGraphicalComparison() {
        let [ok, model, iter] = this.treeView.get_selection().get_selected();
        if (!ok || !iter) return;

        let name = model.get_value(iter, 5);
        if (!name) return;

        let entry = this.iconIndex.get(name);
        if (!entry) return;

        new GraphicalComparisonWindow(this.window, this, name);
    }

    openTextComparison() {
        let [ok, model, iter] = this.treeView.get_selection().get_selected();
        if (!ok || !iter) return;

        let name = model.get_value(iter, 5);
        if (!name) return;

        let entry = this.iconIndex.get(name);
        if (!entry) return;

        new ComparisonWindow(this.window, name, entry.occurrences);
    }

    onTreeRightClick(widget, event) {
        let btn = event.get_button()[1];
        if (btn !== 3) return false;

        let coords;
        try {
            coords = event.get_coords();
        } catch (e) {
            coords = null;
        }

        let x, y;
        if (coords && coords.length >= 2) {
            x = coords[0];
            y = coords[1];
        } else {
            x = event.x;
            y = event.y;
        }

        let pathInfo = this.treeView.get_path_at_pos(Math.floor(x), Math.floor(y));
        if (!pathInfo) return false;

        this.treeView.get_selection().select_path(pathInfo[0]);
        this.onIconSelected();

        let menu = new Gtk.Menu();

        let visualItem = new Gtk.MenuItem({ label: 'Visual comparison' });
        visualItem.connect('activate', () => this.openGraphicalComparison());
        menu.append(visualItem);

        let textItem = new Gtk.MenuItem({ label: 'Text comparison' });
        textItem.connect('activate', () => this.openTextComparison());
        menu.append(textItem);

        menu.show_all();

        try {
            menu.popup_at_pointer(event);
        } catch (e) {
            let time = (event.get_time ? event.get_time() : 0);
            menu.popup(null, null, null, btn, time);
        }

        return true;
    }

    showError(msg) {
        let dialog = new Gtk.MessageDialog({
            transient_for: this.window,
            modal: true,
            message_type: Gtk.MessageType.ERROR,
            buttons: Gtk.ButtonsType.OK,
            text: msg
        });
        dialog.run();
        dialog.destroy();
    }
}

// =====================================================================
// ЗАПУСК
// =====================================================================

let app = new MainApp();

for (let i = 0; i < ARGV.length; i++) {
    let p = ARGV[i];
    if (!p) continue;
    let f = Gio.File.new_for_path(p);
    if (f.query_exists(null)) {
        try { app.addThemeByPath(p); } catch (e) {}
    }
}

Gtk.main();