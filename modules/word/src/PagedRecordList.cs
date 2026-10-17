using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal sealed class PagedRecordList : UserControl
    {
        private readonly ListBox list;
        private readonly Button previous;
        private readonly Button next;
        private readonly Label counter;
        private readonly Func<IDictionary<string, object>, string> describe;
        private List<IDictionary<string, object>> records = new List<IDictionary<string, object>>();
        private int page;
        private int pageSize = 6;
        private bool rendering;

        internal event EventHandler RecordSelected;
        internal event EventHandler RecordOpened;

        internal PagedRecordList(string name, Func<IDictionary<string, object>, string> describe)
        {
            this.describe = describe;
            Dock = DockStyle.Fill;
            Margin = Padding.Empty;
            AutoScroll = false;
            list = new ListBox
            {
                AccessibleName = name, Dock = DockStyle.Fill, IntegralHeight = false,
                HorizontalScrollbar = false, BorderStyle = BorderStyle.FixedSingle
            };
            list.SelectedIndexChanged += delegate { if (!rendering && RecordSelected != null) RecordSelected(this, EventArgs.Empty); };
            list.DoubleClick += delegate { if (Selected != null && RecordOpened != null) RecordOpened(this, EventArgs.Empty); };
            list.Resize += delegate { ResizePage(); };
            list.FontChanged += delegate { ResizePage(); };
            previous = NativeLayout.Button("Previous", delegate { page--; Render(); });
            next = NativeLayout.Button("Next", delegate { page++; Render(); });
            counter = NativeLayout.Label("");
            TableLayoutPanel body = NativeLayout.Column();
            body.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            body.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            body.Controls.Add(list, 0, 0);
            body.Controls.Add(NativeLayout.Actions(counter, previous, next), 0, 1);
            Controls.Add(body);
        }

        internal IDictionary<string, object> Selected
        {
            get
            {
                int index = page * pageSize + list.SelectedIndex;
                return list.SelectedIndex >= 0 && index < records.Count ? records[index] : null;
            }
        }

        internal void UpdateRecords(List<IDictionary<string, object>> updated)
        {
            string selectedId = Selected == null ? "" : UiState.Text(Selected, "id");
            records = updated;
            int index = records.FindIndex(record => UiState.Text(record, "id") == selectedId);
            if (index >= 0) page = index / pageSize;
            Render();
            if (index >= 0) list.SelectedIndex = index % pageSize;
        }

        private void ResizePage()
        {
            if (previous == null) return;
            int selectedIndex = page * pageSize + Math.Max(0, list.SelectedIndex);
            pageSize = Math.Max(1, Math.Min(6, list.ClientSize.Height / Math.Max(1, list.ItemHeight)));
            page = selectedIndex / pageSize;
            Render();
            if (records.Count > selectedIndex) list.SelectedIndex = selectedIndex % pageSize;
        }

        private void Render()
        {
            if (rendering) return;
            rendering = true;
            int selectedIndex = Math.Max(0, list.SelectedIndex);
            page = Math.Max(0, Math.Min(page, Math.Max(0, (records.Count - 1) / pageSize)));
            list.BeginUpdate();
            list.Items.Clear();
            foreach (IDictionary<string, object> record in records.Skip(page * pageSize).Take(pageSize))
                list.Items.Add(NativeLayout.Summary(describe(record), list.Font, Math.Max(20, list.ClientSize.Width - 12)));
            if (list.Items.Count > 0) list.SelectedIndex = Math.Min(selectedIndex, list.Items.Count - 1);
            list.EndUpdate();
            previous.Enabled = page > 0;
            next.Enabled = (page + 1) * pageSize < records.Count;
            counter.Text = records.Count == 0 ? "None" : (page * pageSize + 1) + "–" + Math.Min(records.Count, (page + 1) * pageSize) + " of " + records.Count;
            rendering = false;
            if (RecordSelected != null) RecordSelected(this, EventArgs.Empty);
        }
    }
}
