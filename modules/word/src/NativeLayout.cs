using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.Globalization;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal static class UiState
    {
        internal static IDictionary<string, object> Map(object value)
        {
            IDictionary<string, object> result = value as IDictionary<string, object>;
            return result ?? new Dictionary<string, object>();
        }

        internal static object Get(IDictionary<string, object> source, string key)
        {
            object value;
            return source != null && source.TryGetValue(key, out value) ? value : null;
        }

        internal static string Text(IDictionary<string, object> source, string key)
        {
            return Convert.ToString(Get(source, key), CultureInfo.InvariantCulture) ?? "";
        }

        internal static bool Flag(IDictionary<string, object> source, string key)
        {
            object value = Get(source, key);
            return value != null && Convert.ToBoolean(value, CultureInfo.InvariantCulture);
        }

        internal static List<IDictionary<string, object>> Records(IDictionary<string, object> source, string key)
        {
            List<IDictionary<string, object>> result = new List<IDictionary<string, object>>();
            IEnumerable records = Get(source, key) as IEnumerable;
            if (records != null)
                foreach (object record in records)
                    result.Add(Map(record));
            return result;
        }

        internal static Dictionary<string, object> Args(string key, object value)
        {
            return new Dictionary<string, object> { { key, value } };
        }
    }

    internal static class NativeLayout
    {
        internal static TableLayoutPanel Column()
        {
            TableLayoutPanel table = new TableLayoutPanel
            {
                Dock = DockStyle.Fill, ColumnCount = 1, AutoScroll = false,
                Margin = Padding.Empty, Padding = Padding.Empty
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            return table;
        }

        internal static TableLayoutPanel Stack(params Control[] controls)
        {
            TableLayoutPanel table = Column();
            table.AutoSize = true;
            table.AutoSizeMode = AutoSizeMode.GrowAndShrink;
            for (int index = 0; index < controls.Length; index++)
            {
                table.RowStyles.Add(new RowStyle(SizeType.AutoSize));
                table.Controls.Add(controls[index], 0, index);
            }
            return table;
        }

        internal static TableLayoutPanel Actions(params Control[] controls)
        {
            TableLayoutPanel table = new TableLayoutPanel
            {
                AutoSize = true, Dock = DockStyle.Fill, ColumnCount = controls.Length + 1,
                Margin = new Padding(0, 5, 0, 0), AutoScroll = false
            };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
            for (int index = 0; index < controls.Length; index++)
            {
                table.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
                table.Controls.Add(controls[index], index + 1, 0);
            }
            return table;
        }

        internal static Label Label(string text)
        {
            return new Label
            {
                Text = text, AutoSize = true, Dock = DockStyle.Fill,
                Margin = new Padding(0, 3, 0, 6), UseMnemonic = false,
                TextAlign = ContentAlignment.MiddleLeft
            };
        }

        internal static Button Button(string text, EventHandler clicked)
        {
            Button button = new Button
            {
                Text = text, AccessibleName = text.Replace("&", ""), AutoSize = true,
                AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(9, 4, 9, 4),
                Margin = new Padding(4, 3, 0, 3), UseVisualStyleBackColor = true
            };
            button.Click += clicked;
            return button;
        }

        internal static TextBox TextBox(string name, bool multiline, bool readOnly)
        {
            return new TextBox
            {
                AccessibleName = name, Dock = DockStyle.Fill, Multiline = multiline,
                ReadOnly = readOnly, WordWrap = multiline, BorderStyle = BorderStyle.FixedSingle,
                ScrollBars = multiline ? ScrollBars.Vertical : ScrollBars.None,
                MinimumSize = new Size(0, multiline ? 68 : 24),
                Margin = new Padding(0, 0, 0, 6), HideSelection = false
            };
        }

        internal static GroupBox Group(string title, Control content)
        {
            GroupBox box = new GroupBox
            {
                Text = title, Dock = DockStyle.Fill, AutoSize = true,
                Padding = new Padding(10, 16, 10, 9), Margin = new Padding(0, 5, 0, 5)
            };
            box.Controls.Add(content);
            return box;
        }

        internal static void Attempt(IWin32Window owner, Action action)
        {
            try { action(); }
            catch (Exception error)
            {
                MessageBox.Show(owner, error.GetBaseException().Message, "wrAIter for Word",
                    MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        internal static Color ColorValue(string value)
        {
            try { return ColorTranslator.FromHtml(value); }
            catch (Exception error)
            {
                if (!(error is ArgumentException) && !(error is FormatException)) throw;
                return SystemColors.Control;
            }
        }

        internal static Color ContrastingText(Color color)
        {
            double[] values = { color.R / 255.0, color.G / 255.0, color.B / 255.0 };
            for (int index = 0; index < values.Length; index++)
                values[index] = values[index] <= 0.04045 ? values[index] / 12.92 : Math.Pow((values[index] + 0.055) / 1.055, 2.4);
            double luminance = values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
            return (luminance + 0.05) / 0.05 >= 1.05 / (luminance + 0.05) ? Color.Black : Color.White;
        }

        internal static string Summary(string text, Font font, int width)
        {
            text = text.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");
            TextFormatFlags flags = TextFormatFlags.NoPrefix | TextFormatFlags.SingleLine;
            if (TextRenderer.MeasureText(text, font, Size.Empty, flags).Width <= width) return text;
            int[] boundaries = StringInfo.ParseCombiningCharacters(text);
            int low = 0, high = boundaries.Length;
            while (low < high)
            {
                int candidate = (low + high + 1) / 2;
                int end = candidate < boundaries.Length ? boundaries[candidate] : text.Length;
                string summary = text.Substring(0, end) + "…";
                if (TextRenderer.MeasureText(summary, font, Size.Empty, flags).Width <= width) low = candidate;
                else high = candidate - 1;
            }
            return text.Substring(0, low < boundaries.Length ? boundaries[low] : text.Length) + "…";
        }
    }

    public class NativeDialog : Form
    {
        protected readonly TableLayoutPanel Shell;
        private readonly Font systemFont;
        private readonly Icon appIcon;
        private readonly Size supportedMinimum;
        private bool adjusting;
        private Font enlargedFont;
        private Bitmap brandImage;
        private bool resourcesDisposed;

        internal NativeDialog(string title, Size minimum)
        {
            Text = title;
            appIcon = AppBranding.WindowIcon();
            Icon = appIcon;
            systemFont = SystemFonts.MessageBoxFont;
            Font = systemFont;
            AutoScaleMode = AutoScaleMode.Dpi;
            AutoScaleDimensions = new SizeF(96, 96);
            StartPosition = FormStartPosition.CenterParent;
            MinimumSize = minimum;
            supportedMinimum = minimum;
            Size = new Size(minimum.Width + 60, minimum.Height + 35);
            ShowInTaskbar = false;
            MinimizeBox = false;
            BackColor = SystemColors.Control;
            Shell = NativeLayout.Column();
            Shell.Padding = new Padding(12);
            Controls.Add(Shell);
        }

        protected override void OnShown(EventArgs args)
        {
            TableLayoutPanel footer = null;
            int lastRow = -1;
            foreach (Control control in Shell.Controls)
            {
                int row = Shell.GetRow(control);
                if (row <= lastRow) continue;
                footer = control as TableLayoutPanel;
                lastRow = row;
            }
            if (footer != null && brandImage == null)
            {
                int size;
                using (Graphics graphics = CreateGraphics()) size = (int)Math.Round(24 * graphics.DpiX / 96);
                brandImage = AppBranding.DialogImage(size);
                footer.Controls.Add(new PictureBox {
                    Image = brandImage, SizeMode = PictureBoxSizeMode.Zoom, Size = new Size(size, size),
                    Anchor = AnchorStyles.Left, Margin = new Padding(0, 3, 10, 3),
                    AccessibleName = "wrAIter", AccessibleRole = AccessibleRole.Graphic, TabStop = false
                }, 0, 0);
            }
            ApplyAppearance(SystemInformation.HighContrast);
            base.OnShown(args);
        }

        internal void ApplyAppearance(bool highContrast)
        {
            AppBranding.ApplyPalette(this, highContrast);
        }

        protected override void OnSystemColorsChanged(EventArgs args)
        {
            base.OnSystemColorsChanged(args);
            if (Shell != null && !Disposing && !IsDisposed) ApplyAppearance(SystemInformation.HighContrast);
        }

        protected override void OnLayout(LayoutEventArgs args)
        {
            if (!Disposing && !IsDisposed && !adjusting && Shell != null)
            {
                adjusting = true;
                int gap = Math.Max(10, Math.Min(18, Math.Min(ClientSize.Width / 65, ClientSize.Height / 45)));
                Shell.Padding = new Padding(gap);
                double budget = Math.Min((double)Width / supportedMinimum.Width, (double)Height / supportedMinimum.Height);
                float size = systemFont.SizeInPoints * (float)Math.Max(1, Math.Min(1.1, budget));
                if ((Font == systemFont || Font == enlargedFont) && Math.Abs(Font.SizeInPoints - size) > 0.2)
                {
                    Font previous = enlargedFont;
                    enlargedFont = new Font(systemFont.FontFamily, size, systemFont.Style);
                    Font = enlargedFont;
                    if (previous != null) previous.Dispose();
                }
                adjusting = false;
            }
            base.OnLayout(args);
        }

        protected override void Dispose(bool disposing)
        {
            bool release = disposing && !resourcesDisposed;
            if (release)
            {
                resourcesDisposed = true;
                adjusting = true;
                ResetFont();
            }
            try { base.Dispose(disposing); }
            finally
            {
                if (release && enlargedFont != null) enlargedFont.Dispose();
                if (release && brandImage != null) brandImage.Dispose();
                if (release && appIcon != null) appIcon.Dispose();
            }
        }
    }

    internal sealed class TextDetailDialog : NativeDialog
    {
        internal TextDetailDialog(string title, string text) : base(title, new Size(560, 420))
        {
            Shell.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
            Shell.RowStyles.Add(new RowStyle(SizeType.AutoSize));
            TextBox body = NativeLayout.TextBox(title, true, true);
            body.Text = text;
            Shell.Controls.Add(body, 0, 0);
            Button close = NativeLayout.Button("Close", delegate { Close(); });
            CancelButton = close;
            Shell.Controls.Add(NativeLayout.Actions(close), 0, 1);
        }
    }
}
