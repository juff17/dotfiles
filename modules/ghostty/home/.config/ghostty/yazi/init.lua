-- The viewer pane's Files mode, laid out like the design: a header row with
-- a tab per mode that's on above the path, names without icons (folders end
-- in /), and a status bar with only the mode, name, permissions and position.

-- bin/ghostty-viewer names the modes that are on in GV_MODES, joined by tabs,
-- and which of them this is in GV_AT, counted from 0 (viewer/modes.mjs).
local TABS, AT = {}, tonumber(os.getenv("GV_AT") or "") or 0
for name in string.gmatch(os.getenv("GV_MODES") or "Files", "[^\t]+") do
	local here = #TABS == AT
	TABS[#TABS + 1] = {
		" " .. name .. " ",
		here and ui.Style():fg("#11111b"):bg("#cdd6f4"):bold() or ui.Style():fg("#a6adc8"):bold(),
	}
end

function Root:layout()
	self._chunks = ui.Layout()
		:direction(ui.Layout.VERTICAL)
		:constraints({
			ui.Constraint.Length(2),
			ui.Constraint.Length(Tabs.height()),
			ui.Constraint.Fill(1),
			ui.Constraint.Length(1),
		})
		:split(self._area)
end

function Header:redraw()
	local a = self._area
	local top = ui.Rect { x = a.x, y = a.y, w = a.w, h = 1 }
	local path = ui.Rect { x = a.x, y = a.y + 1, w = a.w, h = 1 }

	local tabs = {}
	for i, t in ipairs(TABS) do
		tabs[#tabs + 1] = ui.Span(t[1]):style(t[2])
		if i < #TABS then
			tabs[#tabs + 1] = " "
		end
	end

	local right = self:children_redraw(self.RIGHT)
	self._right_width = right:width()
	local switch = #TABS > 1 and { ui.Span("tab"):fg("#89b4fa"), ui.Span(" switch"):fg("#a6adc8") } or {}
	return {
		ui.Line(tabs):area(top),
		ui.Line(switch):area(top):align(ui.Align.RIGHT),
		ui.Line(self:children_redraw(self.LEFT)):area(path),
		right:area(path):align(ui.Align.RIGHT),
	}
end

-- bin/ghostty-viewer reads where to go from how yazi quit: plainly (writing
-- its cwd file) after leaving the mode's number in the GV_NEXT_MARK file.
function Header:click(event, up)
	if up or event.y ~= self._area.y then
		return
	end
	local x = self._area.x
	for i, t in ipairs(TABS) do
		local w = ui.width(t[1])
		if event.x >= x and event.x < x + w then
			local mark = i - 1 ~= AT and os.getenv("GV_NEXT_MARK")
			local f = mark and io.open(mark, "w")
			if f then
				f:write(tostring(i - 1))
				f:close()
				ya.emit("quit", {})
			end
			return
		end
		x = x + w + 1
	end
end

Entity:children_remove(2) -- icon
Entity:children_add(function(self) return self._file.cha.is_dir and "/" or "" end, 4500)

Status:children_remove(2, Status.LEFT) -- size
Status:children_remove(5, Status.RIGHT) -- percent

function Status:name()
	local h = self._current.hovered
	return h and "  " .. ui.printable(h.name) or ""
end

function Status:position()
	local cursor, length = self._current.cursor, #self._current.files
	return ui.Line {
		"  ",
		ui.Span(string.format("%d/%d ", math.min(cursor + 1, length), length)):fg("#cdd6f4"),
	}
end
