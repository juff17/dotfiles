-- The viewer pane's Files mode, laid out like the design: a header row with
-- the Diagrams / Files / Diff tabs above the path, names without icons
-- (folders end in /), and a status bar with only the mode, name, permissions
-- and position.

local TABS = {
	{ " Diagrams ", ui.Style():fg("#a6adc8"):bold() },
	{ " Files ", ui.Style():fg("#11111b"):bg("#cdd6f4"):bold() },
	{ " Diff ", ui.Style():fg("#a6adc8"):bold() },
}

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
	return {
		ui.Line(tabs):area(top),
		ui.Line({ ui.Span("tab"):fg("#89b4fa"), ui.Span(" switch"):fg("#a6adc8") }):area(top):align(ui.Align.RIGHT),
		ui.Line(self:children_redraw(self.LEFT)):area(path),
		right:area(path):align(ui.Align.RIGHT),
	}
end

-- bin/ghostty-viewer reads where to go from how yazi quit: plainly (writing
-- its cwd file) for Diff, without the cwd file for Diagrams.
function Header:click(event, up)
	if up or event.y ~= self._area.y then
		return
	end
	local x = self._area.x
	for i, t in ipairs(TABS) do
		local w = ui.width(t[1])
		if event.x >= x and event.x < x + w then
			if i == 1 then
				ya.emit("quit", { no_cwd_file = true })
			elseif i == 3 then
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
