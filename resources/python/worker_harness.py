#!/usr/bin/env python3
"""
Desktop Intelligence — Persistent Python Worker
Reads JSON requests from stdin, executes matplotlib code, writes JSON responses to stdout.
Imports are done once at startup to eliminate per-render cold-start latency.
"""
import sys
import io
import json
import base64
import traceback

# ── Redirect user print() away from the protocol stream ──────────────────────
# The JSON protocol uses stdout. Any print() in user code must not corrupt it.
# We redirect sys.stdout to stderr for the duration of user code execution,
# restoring it only for our own JSON writes.
_protocol_stdout = sys.stdout
sys.stdout = sys.stderr  # default: user prints go to stderr

# ── One-time imports ──────────────────────────────────────────────────────────
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np
try:
    import scipy
    from scipy import stats as scipy_stats
except ImportError:
    scipy_stats = None

# ── rcParams (dark theme) ─────────────────────────────────────────────────────
plt.rcParams.update({
    'figure.facecolor':  '#0f0f0f',
    'axes.facecolor':    '#141414',
    'axes.edgecolor':    '#3a3a3a',
    'axes.labelcolor':   '#a3a3a3',
    'grid.color':        '#2a2a2a',
    'grid.linestyle':    '--',
    'grid.alpha':        0.6,
    'text.color':        '#f5f5f5',
    'xtick.color':       '#a3a3a3',
    'ytick.color':       '#a3a3a3',
    'legend.facecolor':  '#1a1a1a',
    'legend.edgecolor':  '#3a3a3a',
    'legend.labelcolor': '#f5f5f5',
    'axes.prop_cycle':   plt.cycler(color=[
        '#f87171','#60a5fa','#86efac','#fb923c',
        '#c084fc','#67e8f9','#fcd34d','#f472b6']),
    'figure.figsize':    (10, 6),
    'lines.linewidth':   2,
    'font.size':         11,
    'axes.titlesize':    13,
    'axes.titlecolor':   '#f5f5f5',
    'axes.titlepad':     10,
})

# ── Safety shims ──────────────────────────────────────────────────────────────

# plt.show / savefig / close → no-ops (engine epilogue handles capture)
_real_savefig = plt.savefig
_real_close   = plt.close
plt.show    = lambda *a, **kw: None
plt.savefig = lambda *a, **kw: None
plt.close   = lambda *a, **kw: None

# matplotlib.use() → no-op (Agg already set)
matplotlib.use = lambda *a, **kw: None

# suptitle(pad=...) — strip invalid kwarg silently
_orig_suptitle = plt.Figure.suptitle
def _safe_suptitle(self, t, **kw):
    kw.pop('pad', None)
    return _orig_suptitle(self, t, **kw)
plt.Figure.suptitle = _safe_suptitle

# plt.subplots() — cap at 3 columns, wrap in _FlexAxes if capped
class _FlexAxes(list):
    def __init__(self, ax_list, fig):
        super().__init__(ax_list)
        self._fig = fig
        self._overflow = {}
    def __getitem__(self, i):
        if isinstance(i, int) and not (-len(self) <= i < len(self)):
            if i not in self._overflow:
                ax = self._fig.add_axes([0, 0, 0.001, 0.001])
                ax.set_visible(False)
                self._overflow[i] = ax
            return self._overflow[i]
        return list.__getitem__(self, i)

_orig_subplots = plt.subplots
def _safe_subplots(nrows=1, ncols=1, **kw):
    orig_ncols = int(ncols)
    ncols = min(orig_ncols, 3)
    nrows = min(int(nrows), 3)
    if orig_ncols != ncols and 'figsize' in kw:
        w, h = kw['figsize']
        kw['figsize'] = (w * ncols / orig_ncols, h)
    fig, axes = _orig_subplots(nrows, ncols, **kw)
    if orig_ncols > ncols:
        if nrows == 1:
            return fig, _FlexAxes(list(np.atleast_1d(axes)), fig)
        else:
            return fig, [_FlexAxes(list(row), fig) for row in axes]
    return fig, axes
plt.subplots = _safe_subplots

# Covariance matrix repair
def _fix_cov(cov, d=None):
    if cov is None or (isinstance(cov, (int, float)) and not hasattr(cov, '__len__')):
        return cov
    c = np.asarray(cov, dtype=float)
    if c.ndim == 1:
        c = np.diag(np.abs(c))
    elif c.ndim == 2 and c.shape[0] != c.shape[1]:
        c = np.diag(np.abs(np.diag(c)))
    return c

try:
    from scipy.stats import multivariate_normal as _mvn_dist
    _mvn_orig_pdf = _mvn_dist.pdf
    def _mvn_safe_pdf(x, mean=None, cov=1, allow_singular=False, **kw):
        x = np.asarray(x, dtype=float)
        cov = _fix_cov(cov)
        if mean is not None:
            _m = np.asarray(mean, dtype=float)
            d = _m.shape[0] if _m.ndim >= 1 else 1
            if x.ndim == 2 and x.shape[0] == d and x.shape[1] != d:
                x = x.T
        return _mvn_orig_pdf(x, mean=mean, cov=cov, allow_singular=allow_singular, **kw)
    _mvn_dist.pdf = _mvn_safe_pdf
except Exception:
    pass

_orig_mvn_random = np.random.multivariate_normal
def _safe_mvn_random(mean, cov, size=None, **kw):
    cov = _fix_cov(cov)
    return _orig_mvn_random(mean, cov, size=size, **kw)
np.random.multivariate_normal = _safe_mvn_random

# imshow auto-normalise
import matplotlib.axes as _mplaxes
_orig_imshow = _mplaxes.Axes.imshow
def _auto_norm_imshow(self, X, **kw):
    if 'vmin' not in kw and 'vmax' not in kw and 'norm' not in kw:
        try:
            arr = np.asarray(X)
            if arr.ndim == 2:
                vmin, vmax = float(arr.min()), float(arr.max())
                if vmin != vmax:
                    kw['vmin'] = vmin
                    kw['vmax'] = vmax
        except Exception:
            pass
    return _orig_imshow(self, X, **kw)
_mplaxes.Axes.imshow = _auto_norm_imshow

# Banned import guard
import builtins as _builtins
_orig_import = _builtins.__import__
_BANNED = frozenset(['sklearn', 'pandas', 'seaborn', 'torch', 'tensorflow', 'keras'])
def _guarded_import(name, *args, **kwargs):
    root = name.split('.')[0]
    if root in _BANNED:
        raise ImportError(
            f"'{name}' is not available in Desktop Intelligence's Python sandbox. "
            f"Use numpy, scipy, or matplotlib directly instead."
        )
    return _orig_import(name, *args, **kwargs)
_builtins.__import__ = _guarded_import

# ── Signal ready ──────────────────────────────────────────────────────────────
_protocol_stdout.write(json.dumps({"ready": True}) + '\n')
_protocol_stdout.flush()

# ── Request loop ──────────────────────────────────────────────────────────────
def execute_chart(user_code: str) -> dict:
    """Execute user matplotlib code and return base64 PNG or error."""
    user_stdout_capture = io.StringIO()

    exec_globals = {
        'plt': plt,
        'np': np,
        'scipy_stats': scipy_stats,
        '__builtins__': __builtins__,
    }

    try:
        sys.stdout = user_stdout_capture
        exec(user_code, exec_globals)
        sys.stdout = sys.stderr

        try:
            plt.gcf().tight_layout()
        except Exception:
            pass

        buf = io.BytesIO()
        _real_savefig(buf, format='png', dpi=150, bbox_inches='tight', facecolor='#0f0f0f')
        buf.seek(0)
        image_base64 = base64.b64encode(buf.read()).decode('ascii')
        _real_close('all')

        return {"success": True, "imageBase64": image_base64}

    except Exception:
        sys.stdout = sys.stderr
        _real_close('all')
        tb = traceback.format_exc()
        lines = tb.strip().split('\n')
        user_line_info = ''
        for i, line in enumerate(lines):
            if 'File "<string>"' in line:
                user_line_info = lines[i] + '\n' + (lines[i + 1] if i + 1 < len(lines) else '')
        error_msg = lines[-1] if lines else 'Unknown error'
        full_error = (user_line_info + '\n' + error_msg).strip() if user_line_info else error_msg
        return {"success": False, "error": full_error}


for raw_line in sys.stdin:
    raw_line = raw_line.strip()
    if not raw_line:
        continue
    try:
        request = json.loads(raw_line)
    except json.JSONDecodeError as e:
        response = {"success": False, "error": f"Invalid JSON request: {e}"}
        _protocol_stdout.write(json.dumps(response) + '\n')
        _protocol_stdout.flush()
        continue

    if request.get('cmd') == 'exit':
        break

    user_code = request.get('code', '')
    response = execute_chart(user_code)
    _protocol_stdout.write(json.dumps(response) + '\n')
    _protocol_stdout.flush()
