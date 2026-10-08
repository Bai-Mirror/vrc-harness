"""Find controls in the GUI that appear to have nothing wired to them.

A button with no handler is either a design mistake, a capability that was never connected, or a leftover.
The orderer asked for a factual list, so this reports what the source shows rather than guessing at intent.

The tag scanner tracks brace depth: an attribute like `disabled={(page+1)*20>total}` contains a `>` that
is not the end of the tag, and stopping there reported two buttons as handler-less that are not.
"""
import re
import sys
from pathlib import Path

# Resolved from this file rather than the working directory, so running it from anywhere audits the same
# tree. A scan over an empty directory reports a clean result, which is the wrong kind of wrong.
root = Path(__file__).resolve().parent.parent / 'gui' / 'src'
if not root.is_dir():
    sys.exit(f'GUI source not found at {root}')


def opening_tags(text, name):
    """Every `<button ...>` opening tag, with brace depth respected."""
    for match in re.finditer(r'<button\b', text):
        depth, index = 0, match.end()
        while index < len(text):
            char = text[index]
            if char == '{':
                depth += 1
            elif char == '}':
                depth -= 1
            elif char == '>' and depth == 0:
                yield match.start(), text[match.start():index + 1]
                break
            index += 1


findings = []
for path in sorted(root.glob('*.tsx')):
    text = path.read_text(encoding='utf-8')
    for start, tag in opening_tags(text, path.name):
        line = text[:start].count('\n') + 1
        handlers = re.findall(r'on[A-Z]\w*=', tag)
        disabled = re.search(r'(?<![.\w])disabled(=\{[^}]*\}|(?=[\s>]))', tag)
        if not handlers:
            findings.append((path.name, line, 'no handler' + (' + disabled' if disabled else ''),
                             re.sub(r'\s+', ' ', tag)[:100]))

print(f'buttons with no event handler: {len(findings)}')
for name, line, why, tag in findings:
    print(f'  {name}:{line}  {why}\n      {tag}')

# Only the handler-less case is treated as a failure. "Disabled unconditionally" was reported here once and
# was wrong twice over — the pattern matched a property access and a real flag — so it stays informational
# rather than deciding anything.
always = []
for path in sorted(root.glob('*.tsx')):
    text = path.read_text(encoding='utf-8')
    for start, tag in opening_tags(text, path.name):
        line = text[:start].count('\n') + 1
        if re.search(r'(?<![.\w])disabled(=\{true\}|(?=[\s>]))', tag):
            always.append((path.name, line, re.sub(r'\s+', ' ', tag)[:100]))
print(f'\nbuttons disabled unconditionally: {len(always)} (reported, not enforced)')
for name, line, tag in always:
    print(f'  {name}:{line}\n      {tag}')

if '--check' in sys.argv:
    if findings:
        sys.exit(f'{len(findings)} button(s) open with no event handler')
    print('every button opens with a handler')
