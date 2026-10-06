#!/usr/bin/gjs
// Для Termux с CJS замени shebang на:
// #!/usr/bin/cjs
//
// Icon Theme Comparer
// Загружает несколько index.theme, показывает объединённый список имён значков
// с фильтром (как в icon-theme-editor). По двойному клику — окно сравнения
// одного имени во всех загруженных темах. Правая панель показывает, в каких
// темах есть выделенный значок, в каких контекстах и какого размера, файл
// это или симлинк и куда он указывает.

imports.gi.versions.Gtk = '3.0';
const Gtk = imports.gi.Gtk;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;
const GObject = imports.gi.GObject;
const GdkPixbuf = imports.gi.GdkPixbuf;

Gtk.init(null);

// =====================================================================
// УТИЛИТЫ
// =====================================================================

function decodeContents(contents) {
    if (typeof contents === 'string') return contents;
    if (typeof TextDecoder !== 'undefined') {
        try { return new TextDecoder('utf-8').decode(contents); } catch (e) {}
    }
    try { return imports.byteArray.toString(contents); } catch (e) {}
    let s = '';
    for (let i = 0; i < contents.length; i++) s += String.fromCharCode(contents[i]);
    return s;
}

function readFile(path) {
    try {
        let file = Gio.File.new_for_path(path);
        let [ok, contents] = file.load_contents(null);
        if (!ok) return null;
        return decodeContents(contents);
    } catch (e) { return null; }
}

function escapeMarkup(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function pixbufFromFile(path, size) {
    try {
        // 1. Читаем как есть, без интерполяции
        let raw = GdkPixbuf.Pixbuf.new_from_file(path);
        let w = raw.get_width();
        let h = raw.get_height();

        if (w === size && h === size) return raw;

        // 2. Масштабируем NEAREST с сохранением пропорций
        let scale = Math.min(size / w, size / h);
        let newW = Math.max(1, Math.round(w * scale));
        let newH = Math.max(1, Math.round(h * scale));
        let scaled = raw.scale_simple(newW, newH, GdkPixbuf.InterpType.NEAREST);

        if (newW === size && newH === size) return scaled;

        // 3. Центрируем на прозрачном полотне
        let canvas = GdkPixbuf.Pixbuf.new(
            GdkPixbuf.Colorspace.RGB, true, 8, size, size);
        canvas.fill(0x00000000);
        scaled.copy_area(0, 0, newW, newH, canvas,
            Math.floor((size - newW) / 2),
            Math.floor((size - newH) / 2));
        return canvas;
    } catch (e) {
        return null;
    }
}

function resolveTargetPath(themeDir, dirName, target) {
    // Резолвим относительный путь симлинка.
    try {
        let base = GLib.build_filenamev([themeDir, dirName]);
        return GLib.canonicalize_filename(target, base);
    } catch (e) { return null; }
}

// =====================================================================
// КЛАСС ICONTHEME — распарсенная тема
// =====================================================================

class IconTheme {
    constructor(indexPath) {
        this.indexPath = indexPath;
        this.dir = GLib.path_get_dirname(indexPath);
        this.name = GLib.path_get_basename(this.dir);
        this.comment = '';
        this.directoryList = [];      // ["16", "22", "devices/48", ...]
        this.directories = new Map(); // dirName -> {context, size, type, scale}
        this.icons = new Map();       // baseName -> {occurrences: [{...}]}
        this.error = null;
    }

    load() {
        try {
            let content = readFile(this.indexPath);
            if (!content) {
                this.error = 'Cannot read ' + this.indexPath;
                return false;
            }
            this.parseIndex(content);
            this.scanIcons();
            return true;
        } catch (e) {
            this.error = e.message || String(e);
            return false;
        }
    }

    parseIndex(content) {
        let lines = content.split(/\r?\n/);
        let currentSection = null;
        let inIconTheme = false;
        let dirs = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].trim();
            if (!line || line.charAt(0) === '#') continue;

            if (line.charAt(0) === '[' && line.charAt(line.length - 1) === ']') {
                currentSection = line.substring(1, line.length - 1);
                inIconTheme = (currentSection === 'Icon Theme');
                if (!inIconTheme) {
                    this.directories.set(currentSection, {
                        context: '', size: null, type: '', scale: null
                    });
                }
                continue;
            }

            let eq = line.indexOf('=');
            if (eq < 0) continue;
            let key = line.substring(0, eq).trim();
            let value = line.substring(eq + 1).trim();

            if (inIconTheme) {
                if (key === 'Name') this.name = value;
                else if (key === 'Comment') this.comment = value;
                else if (key === 'Directories') {
                    dirs = value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
                }
            } else if (currentSection) {
                let d = this.directories.get(currentSection);
                if (!d) continue;
                if (key === 'Context') d.context = value;
                else if (key === 'Size') d.size = parseInt(value) || null;
                else if (key === 'Type') d.type = value;
                else if (key === 'Scale') d.scale = parseInt(value) || null;
            }
        }

        this.directoryList = dirs;
    }

    scanIcons() {
        let validExts = ['.png', '.svg', '.xpm'];
        let self = this;

        for (let k = 0; k < this.directoryList.length; k++) {
            let dirName = this.directoryList[k];
            let dirInfo = this.directories.get(dirName);
            if (!dirInfo) continue;

            let absDir = GLib.build_filenamev([this.dir, dirName]);
            let dir = Gio.File.new_for_path(absDir);
            if (!dir.query_exists(null)) continue;

            let enumerator;
            try {
                enumerator = dir.enumerate_children(
                    'standard::name,standard::type,standard::is-symlink,standard::symlink-target',
                    Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
            } catch (e) {
                continue;
            }

            let info;
            while ((info = enumerator.next_file(null)) !== null) {
                let name = info.get_name();
                let dot = name.lastIndexOf('.');
                if (dot < 0) continue;
                let ext = name.substring(dot).toLowerCase();
                if (validExts.indexOf(ext) < 0) continue;

                let baseName = name.substring(0, dot);
                let isSymlink = info.get_is_symlink();
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
            enumerator.close(null);
        }
    }
}

// =====================================================================
// ГРАФИЧЕСКОЕ ОКНО СРАВНЕНИЯ: строки = размеры, столбцы = темы
// =====================================================================

class GraphicalComparisonWindow {
    constructor(parent, app, iconName) {
        this.app = app;
        this.iconName = iconName;

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

    // Возвращает ключ строки для вхождения значка.
    // Если size задан — числовая строка; иначе — тип (например, "Scalable").
    rowKeyOf(occ) {
        if (occ.size != null) return String(occ.size);
        if (occ.type) return occ.type;
        return '?';
    }

    // Числовой ключ для сортировки строк.
    rowSortKeyOf(occ) {
        if (occ.size != null) return occ.size;
        return 999999;
    }

    buildUI() {
        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 8
        });

        let entry = this.app.iconIndex.get(this.iconName);
        let occurrences = entry ? entry.occurrences : [];

        // ---------- Шапка ----------
        let header = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 10 });

        let preview = new Gtk.Image();
        preview.set_size_request(64, 64);
        let pb = null;
        for (let i = 0; i < occurrences.length; i++) {
            if (!occurrences[i].isSymlink) {
                pb = pixbufFromFile(occurrences[i].fullPath, 64);
                if (pb) break;
            }
        }
        if (!pb) {
            for (let i = 0; i < occurrences.length; i++) {
                pb = pixbufFromFile(occurrences[i].fullPath, 64);
                if (pb) break;
            }
        }
        preview.set_from_pixbuf(pb);
        header.pack_start(preview, false, false, 0);

        let themesCount = this.app.themes.length;
        let hdrLabel = new Gtk.Label({
            label: '<b>' + escapeMarkup(this.iconName) + '</b>\n' +
                   'Rows = size, Columns = theme (' + themesCount + ')',
            use_markup: true,
            halign: Gtk.Align.START
        });
        header.pack_start(hdrLabel, false, false, 0);
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

        // ---------- Собираем строки (уникальные размеры) ----------
        let rowMap = new Map();   // key -> sortKey
        for (let i = 0; i < occurrences.length; i++) {
            let key = this.rowKeyOf(occurrences[i]);
            if (!rowMap.has(key)) rowMap.set(key, this.rowSortKeyOf(occurrences[i]));
        }

        let rows = Array.from(rowMap.keys());
        rows.sort(function(a, b) {
            let ka = rowMap.get(a);
            let kb = rowMap.get(b);
            if (ka !== kb) return ka - kb;
            return a.localeCompare(b);
        });

        // ---------- Модель ----------
        // [0] size string
        // [1] numeric sort key (int)
        // затем для каждой темы: pixbuf, cell-background, type-string
        let colTypes = [GObject.TYPE_STRING, GObject.TYPE_INT];
        for (let i = 0; i < themesCount; i++) {
            colTypes.push(GdkPixbuf.Pixbuf);
            colTypes.push(GObject.TYPE_STRING);
            colTypes.push(GObject.TYPE_STRING);
        }

        this.store = new Gtk.ListStore();
        this.store.set_column_types(colTypes);

        let self = this;
        for (let ri = 0; ri < rows.length; ri++) {
            let sz = rows[ri];
            let rowData = [sz, rowMap.get(sz)];

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
                    let pix = pixbufFromFile(match.fullPath, 48);
                    let bg = match.isSymlink ? '#D9E6F2' : '#FFFFFF';
                    rowData.push(pix);
                    rowData.push(bg);
                    rowData.push(match.isSymlink ? 'symlink' : 'file');
                } else {
                    rowData.push(null);
                    rowData.push('#F0F0F0');
                    rowData.push('');
                }
            }

            let iter = this.store.append();
            let idx = [];
            for (let k = 0; k < rowData.length; k++) idx.push(k);
            this.store.set(iter, idx, rowData);
        }

        // ---------- TreeView ----------
        this.view = new Gtk.TreeView({
            model: this.store,
            headers_clickable: true
        });

        // Колонка "Size"
let sizeR = new Gtk.CellRendererText();
sizeR.set_property('xpad', 6);
let sizeC = new Gtk.TreeViewColumn({ title: 'Size' });
sizeC.pack_start(sizeR, true);       // было false — теперь тянется
sizeC.add_attribute(sizeR, 'text', 0);
sizeC.set_min_width(60);
sizeC.set_resizable(true);
sizeC.set_expand(true);              // ← ключевая строка: колонка забирает свободное место
sizeC.set_sort_column_id(1);
sizeC.set_clickable(true);
this.view.append_column(sizeC);

        // По колонке на каждую тему
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

        let scroll = new Gtk.ScrolledWindow();
        scroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.AUTOMATIC);
        scroll.add(this.view);
        mainBox.pack_start(scroll, true, true, 0);

        // Легенда
        let legend = new Gtk.Label({
            label: '<small>White = file, blue = symlink, gray = missing</small>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        mainBox.pack_start(legend, false, false, 0);

        // Кнопка Close
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
// ОКНО СРАВНЕНИЯ
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
        this.window.connect('destroy', function() {});

        this.buildUI();
        this.window.show_all();
    }

    buildUI() {
        let mainBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin: 8
        });

        // ---- Шапка ----
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

        // ---- Таблица ----
        let store = new Gtk.ListStore();
        store.set_column_types([
            GObject.TYPE_STRING, // 0 theme
            GObject.TYPE_STRING, // 1 dir
            GObject.TYPE_STRING, // 2 context
            GObject.TYPE_STRING, // 3 size
            GObject.TYPE_STRING, // 4 type
            GObject.TYPE_STRING, // 5 target
            GObject.TYPE_STRING, // 6 full path
            GObject.TYPE_STRING  // 7 reverse count
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

        // ---- Кнопка закрытия ----
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
        this.iconIndex = new Map();   // name -> {name, occurrences[], themes:Set, contexts:Set}
        this.filteredNames = [];
        this.currentName = null;
        this.filterTimer = null;

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

        // ---------- Тулбар ----------
        let toolbar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 5 });

        let addBtn = new Gtk.Button({ label: 'Add Theme...' });
        addBtn.set_tooltip_text('Add an icon theme (select its directory or index.theme file)');
        addBtn.connect('clicked', () => this.onAddTheme());
        toolbar.pack_start(addBtn, false, false, 0);

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

        mainBox.pack_start(toolbar, false, false, 0);

        // ---------- Строка тегов тем ----------
        this.themesBar = new Gtk.Box({ orientation: Gtk.Orientation.HORIZONTAL, spacing: 4 });
        let themesScroll = new Gtk.ScrolledWindow();
        themesScroll.set_policy(Gtk.PolicyType.AUTOMATIC, Gtk.PolicyType.NEVER);
        themesScroll.set_size_request(-1, 44);
        themesScroll.add(this.themesBar);
        mainBox.pack_start(themesScroll, false, false, 0);

        // ---------- Основной сплит ----------
        let split = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 5,
            hexpand: true,
            vexpand: true
        });

        // --- Левая: таблица имён значков ---
        let leftBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true,
            vexpand: true,
            width_request: 450
        });

        this.listStore = new Gtk.ListStore();
        this.listStore.set_column_types([
            GObject.TYPE_STRING, // 0 name
            GObject.TYPE_STRING, // 1 color
            GObject.TYPE_STRING, // 2 coverage
            GObject.TYPE_STRING, // 3 contexts
            GObject.TYPE_STRING, // 4 status
            GObject.TYPE_STRING  // 5 baseName (lookup)
        ]);

        this.treeView = new Gtk.TreeView({
            model: this.listStore,
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

        split.pack_start(leftBox, true, true, 0);

        // --- Правая: инфо о выделенном значке ---
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

this.infoStore = new Gtk.ListStore();
this.infoStore.set_column_types([
    GObject.TYPE_STRING, // 0 theme
    GObject.TYPE_STRING, // 1 dir
    GObject.TYPE_STRING, // 2 context
    GObject.TYPE_STRING, // 3 size (текст)
    GObject.TYPE_STRING, // 4 type
    GObject.TYPE_STRING, // 5 target
    GObject.TYPE_INT     // 6 size sort key (скрытая, только для сортировки)
]);

        this.infoView = new Gtk.TreeView({
            model: this.infoStore,
            headers_clickable: true
        });

// [title, textIndex, expand, minWidth, sortColumnId]
let infoCols = [
    ['Theme',   0, false, 100, 0],
    ['Dir',     1, true,  120, 1],
    ['Context', 2, false, 80,  2],
    ['Size',    3, false, 50,  6],   // сортировка по скрытому int-столбцу
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
        rightBox.pack_start(infoScroll, true, true, 0);

        let hint = new Gtk.Label({
            label: '<i>Double-click an icon to open the comparison window</i>',
            use_markup: true,
            halign: Gtk.Align.START
        });
        rightBox.pack_start(hint, false, false, 0);

        split.pack_start(rightBox, false, false, 0);

        mainBox.pack_start(split, true, true, 0);

        // ---------- Статусбар ----------
        this.statusbar = new Gtk.Statusbar();
        this.statusContextId = this.statusbar.get_context_id('main');
        mainBox.pack_start(this.statusbar, false, false, 0);

        this.window.add(mainBox);
        this.window.show_all();

        this.updateThemesBar();
        this.updateStatus();
    }

    // ================= СТАТУС =================
    setStatus(msg) {
        this.statusbar.remove_all(this.statusContextId);
        this.statusbar.push(this.statusContextId, msg);
    }

    updateStatus() {
        this.setStatus(this.themes.length + ' theme(s) loaded, ' +
                       this.iconIndex.size + ' unique icon name(s)');
    }

    // ================= ТЕГИ ТЕМ =================
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
                    this.applyFilter();
                    this.updateStatus();
                });
                box.pack_start(xBtn, false, false, 0);
                frame.add(box);
                this.themesBar.pack_start(frame, false, false, 0);
            }
        }

        this.themesBar.show_all();
    }

    // ================= ДОБАВЛЕНИЕ =================
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

        if (path) this.addThemeByPath(path);
    }

    addThemeByPath(path) {
        // Принимаем и папку, и файл index.theme
        let file = Gio.File.new_for_path(path);
        let info;
        try {
            info = file.query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        } catch (e) {
            this.showError('Cannot access:\n' + path);
            return;
        }

        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            let indexPath = GLib.build_filenamev([path, 'index.theme']);
            if (!Gio.File.new_for_path(indexPath).query_exists(null)) {
                this.showError('Directory does not contain index.theme:\n' + path);
                return;
            }
            path = indexPath;
        } else if (GLib.path_get_basename(path) !== 'index.theme') {
            this.showError('Expected index.theme (or a directory containing one).\nGot:\n' + path);
            return;
        }

        for (let i = 0; i < this.themes.length; i++) {
            if (this.themes[i].indexPath === path) {
                this.showError('Theme already loaded:\n' + path);
                return;
            }
        }

        let theme = new IconTheme(path);
        if (!theme.load()) {
            this.showError('Failed to load theme:\n' + (theme.error || 'unknown error'));
            return;
        }

        this.themes.push(theme);
        this.rebuildIndex();
        this.updateThemesBar();
        this.applyFilter();
        this.updateStatus();
    }

    // ================= УДАЛЕНИЕ =================
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
                this.applyFilter();
                this.updateStatus();
            }
        }
        dialog.destroy();
    }

    // ================= ОБНОВЛЕНИЕ =================
    onRefreshAll() {
        for (let i = 0; i < this.themes.length; i++) {
            let t = this.themes[i];
            t.icons.clear();
            t.directories.clear();
            t.directoryList = [];
            t.load();
        }
        this.rebuildIndex();
        this.applyFilter();
        this.updateStatus();
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
    }

    // ================= ФИЛЬТР =================
    onFilterChanged() {
        if (this.filterTimer) {
            GLib.source_remove(this.filterTimer);
            this.filterTimer = null;
        }
        this.filterTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
            this.filterTimer = null;
            this.applyFilter();
            return false;
        });
    }

    applyFilter() {
        let text = this.filterEntry.get_text().toLowerCase();

        this.filteredNames = [];
        for (let [name, entry] of this.iconIndex) {
            if (text === '' || name.toLowerCase().indexOf(text) >= 0) {
                this.filteredNames.push(name);
            }
        }
        this.filteredNames.sort();

        this.updateListDisplay();
    }

    updateListDisplay() {
        this.listStore.clear();

        let totalThemes = this.themes.length;

        for (let i = 0; i < this.filteredNames.length; i++) {
            let name = this.filteredNames[i];
            let entry = this.iconIndex.get(name);
            let iter = this.listStore.append();

            let coverage = entry.themes.size + '/' + totalThemes;
            let contextsStr;
            if (entry.contexts.size > 1) contextsStr = 'Multiple';
            else if (entry.contexts.size === 1) contextsStr = entry.contexts.values().next().value;
            else contextsStr = '';

            let symlinkCount = 0;
            for (let oi = 0; oi < entry.occurrences.length; oi++) {
                if (entry.occurrences[oi].isSymlink) symlinkCount++;
            }

            let status, color;
            if (entry.themes.size < totalThemes) {
                color = 'red';
                status = 'Missing in ' + (totalThemes - entry.themes.size);
            } else if (symlinkCount === entry.occurrences.length) {
                color = 'purple';
                status = 'Symlinks only';
            } else if (symlinkCount > 0) {
                color = 'blue';
                status = 'Has symlinks';
            } else {
                color = 'black';
                status = 'OK';
            }

            this.listStore.set(iter, [0, 1, 2, 3, 4, 5],
                [name, color, coverage, contextsStr, status, name]);
        }
    }

    // ================= ВЫБОР =================
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

        this.infoStore.clear();

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

        this.infoText.set_markup(infoText);

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

// В самом конце showIconInfo(), после заполнения infoStore:
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

onInfoRowSelected() {
    let [ok, model, iter] = this.infoView.get_selection().get_selected();
    if (!ok || !iter) return;

    // В infoStore:
    // 0 theme, 1 dir (relPath), 2 context, 3 size, 4 type, 5 target, 6 sizeKey
    let relPath = model.get_value(iter, 1);
    if (!relPath) return;

    let entry = this.iconIndex.get(this.currentName);
    if (!entry) return;

    // Ищем occurrence, соответствующий выбранной строке
    let match = null;
    for (let i = 0; i < entry.occurrences.length; i++) {
        let occ = entry.occurrences[i];
        if (occ.relPath !== relPath) continue;

        // На всякий случай сверяем тему и цель, чтобы различить
        // одноимённые записи (маловероятно, но возможно)
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
    if (btn !== 3) return false;   // только правая кнопка

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

    // В GTK 3.22+ предпочтительный способ — popup_at_pointer.
    // Для более старых версий — fallback на popup().
    try {
        menu.popup_at_pointer(event);
    } catch (e) {
        let time = (event.get_time ? event.get_time() : 0);
        menu.popup(null, null, null, btn, time);
    }

    return true;
}

    // ================= ДИАЛОГ ОШИБКИ =================
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

// Аргументы командной строки: пути к index.theme или папкам с ними.
for (let i = 0; i < ARGV.length; i++) {
    let p = ARGV[i];
    if (!p) continue;
    let f = Gio.File.new_for_path(p);
    if (f.query_exists(null)) {
        try { app.addThemeByPath(p); } catch (e) {}
    }
}

Gtk.main();