class XSelectionRequest(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('owner', ctypes.c_ulong), ('requestor', ctypes.c_ulong),
                ('selection', ctypes.c_ulong), ('target', ctypes.c_ulong),
                ('property', ctypes.c_ulong), ('time', ctypes.c_ulong)]


class XSelectionNotify(ctypes.Structure):
    _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong), ('send_event', ctypes.c_int),
                ('display', ctypes.c_void_p), ('requestor', ctypes.c_ulong),
                ('selection', ctypes.c_ulong), ('target', ctypes.c_ulong),
                ('property', ctypes.c_ulong), ('time', ctypes.c_ulong)]


class XEvent(ctypes.Union):
    _fields_ = [('type', ctypes.c_int), ('request', XSelectionRequest),
                ('notification', XSelectionNotify), ('pad', ctypes.c_long * 24)]


class XConnection:
    def __init__(self):
        self.x = ctypes.CDLL('libX11.so.6')
        self.xt = ctypes.CDLL('libXtst.so.6')
        self.x.XOpenDisplay.argtypes = [ctypes.c_char_p]
        self.x.XOpenDisplay.restype = ctypes.c_void_p
        self.x.XDefaultScreen.argtypes = [ctypes.c_void_p]
        self.x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
        self.x.XDefaultRootWindow.restype = ctypes.c_ulong
        self.x.XDisplayWidth.argtypes = self.x.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
        self.x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                        ctypes.POINTER(ctypes.c_uint)]
        self.x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
        self.x.XCloseDisplay.argtypes = [ctypes.c_void_p]
        self.x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
        self.x.XInternAtom.restype = ctypes.c_ulong
        self.x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                              ctypes.c_int, ctypes.c_uint, ctypes.c_uint,
                                              ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong]
        self.x.XCreateSimpleWindow.restype = ctypes.c_ulong
        self.x.XSetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        self.x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.x.XGetSelectionOwner.restype = ctypes.c_ulong
        self.x.XDestroyWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
        self.x.XChangeProperty.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong,
                                          ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
                                          ctypes.c_void_p, ctypes.c_int]
        self.x.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int,
                                     ctypes.c_long, ctypes.POINTER(XEvent)]
        self.x.XPending.argtypes = [ctypes.c_void_p]
        self.x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
        self.x.XConnectionNumber.argtypes = [ctypes.c_void_p]
        self.xt.XTestFakeKeyEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.xt.XTestFakeButtonEvent.argtypes = [ctypes.c_void_p, ctypes.c_uint, ctypes.c_int, ctypes.c_ulong]
        self.display = self.x.XOpenDisplay(b':1')
        require(self.display)
        self.input_started = False
        self.selection_window = 0
        self.selections = []
        screen = self.x.XDefaultScreen(self.display)
        require(self.x.XDisplayWidth(self.display, screen) == WIDTH and
                self.x.XDisplayHeight(self.display, screen) == HEIGHT, 'STALE_FRAME')

    def keymap(self):
        keys = ctypes.create_string_buffer(32)
        require(self.x.XQueryKeymap(self.display, keys) != 0, 'CLEANUP_UNKNOWN')
        return keys.raw

    def buttons(self):
        root, child = ctypes.c_ulong(), ctypes.c_ulong()
        root_x, root_y, win_x, win_y = (ctypes.c_int() for _ in range(4))
        mask = ctypes.c_uint()
        require(self.x.XQueryPointer(self.display, self.x.XDefaultRootWindow(self.display),
                                    ctypes.byref(root), ctypes.byref(child), ctypes.byref(root_x),
                                    ctypes.byref(root_y), ctypes.byref(win_x), ctypes.byref(win_y),
                                    ctypes.byref(mask)) != 0, 'CLEANUP_UNKNOWN')
        return mask.value & 0x1f00

    def begin_input(self):
        # A session never accepts held-key streams. Refuse an unexpected pre-existing
        # press rather than releasing another operation's state.
        require(not any(self.keymap()) and self.buttons() == 0, 'INPUT_FAILED')
        self.input_started = True

    def release(self):
        # Only runs for this serialized input operation, never for status/capture.
        if not self.input_started:
            return
        keys = self.keymap()
        for code in range(8, 256):
            if keys[code // 8] & (1 << (code % 8)):
                require(self.xt.XTestFakeKeyEvent(self.display, code, 0, 0) != 0, 'CLEANUP_UNKNOWN')
        for button in range(1, 8):
            require(self.xt.XTestFakeButtonEvent(self.display, button, 0, 0) != 0, 'CLEANUP_UNKNOWN')
        self.x.XSync(self.display, 0)
        require(not any(self.keymap()) and self.buttons() == 0, 'CLEANUP_UNKNOWN')

    def clear_selection(self):
        owner = self.selection_window
        if not owner:
            return
        for selection in self.selections:
            if self.x.XGetSelectionOwner(self.display, selection) == owner:
                self.x.XSetSelectionOwner(self.display, selection, 0, 0)
        self.x.XDestroyWindow(self.display, owner)
        self.x.XSync(self.display, 0)
        require(all(self.x.XGetSelectionOwner(self.display, atom) != owner for atom in self.selections),
                'CLEANUP_UNKNOWN')
        self.selection_window = 0
        self.selections = []

    def paste_text(self, text):
        """Serve this request's UTF-8 bytes; never inspect or preserve old clipboard data."""
        atom = lambda name: self.x.XInternAtom(self.display, name.encode('ascii'), 0)
        utf8, targets, text_atom, atom_type = (atom(name) for name in ('UTF8_STRING', 'TARGETS', 'TEXT', 'ATOM'))
        self.selections = [atom('PRIMARY'), atom('CLIPBOARD')]
        self.selection_window = self.x.XCreateSimpleWindow(
            self.display, self.x.XDefaultRootWindow(self.display), 0, 0, 1, 1, 0, 0, 0)
        require(self.selection_window, 'INPUT_FAILED')
        content = text.encode('utf-8')
        try:
            for selection in self.selections:
                self.x.XSetSelectionOwner(self.display, selection, self.selection_window, 0)
            self.x.XSync(self.display, 0)
            require(all(self.x.XGetSelectionOwner(self.display, selection) == self.selection_window
                        for selection in self.selections), 'INPUT_FAILED')
            xdotool('key', '--delay', '0', 'shift+Insert')
            requests = 0
            while True:
                interrupted()
                if not self.x.XPending(self.display):
                    select.select([self.x.XConnectionNumber(self.display)], [], [], 0.025)
                    continue
                event = XEvent()
                self.x.XNextEvent(self.display, ctypes.byref(event))
                if event.type == 29:  # SelectionClear: another owner replaced our temporary text.
                    raise Failure('INPUT_FAILED')
                if event.type != 30:
                    continue
                request = event.request
                if request.owner != self.selection_window or request.selection not in self.selections:
                    continue
                requests += 1
                require(requests <= 32, 'INPUT_FAILED')
                prop = request.property or request.target
                delivered = False
                if request.target == targets:
                    offered = (ctypes.c_ulong * 3)(targets, utf8, text_atom)
                    self.x.XChangeProperty(self.display, request.requestor, prop, atom_type, 32, 0,
                                           offered, 3)
                elif request.target in (utf8, text_atom):
                    data = ctypes.create_string_buffer(content)
                    self.x.XChangeProperty(self.display, request.requestor, prop, utf8, 8, 0,
                                           data, len(content))
                    delivered = True
                else:
                    prop = 0  # Refuse lossy STRING conversion, INCR and unsupported targets.
                response = XEvent()
                response.notification = XSelectionNotify(
                    31, 0, 1, self.display, request.requestor, request.selection,
                    request.target, prop, request.time)
                require(self.x.XSendEvent(self.display, request.requestor, 0, 0, ctypes.byref(response)),
                        'INPUT_FAILED')
                self.x.XSync(self.display, 0)
                if delivered:
                    # Data now lives on the requestor's property. Closing our owner
                    # cannot remove it; the receiver can consume the queued notify.
                    return
        finally:
            self.clear_selection()

    def close(self):
        if self.display:
            self.clear_selection()
            self.x.XCloseDisplay(self.display)
            self.display = None


