using System.Drawing;
using System.Windows.Forms;

namespace UnderTree.WordAddin
{
    internal static class AppBranding
    {
        internal static Bitmap RibbonImage()
        {
            using (var stream = typeof(AppBranding).Assembly.GetManifestResourceStream("wrAIter.Ribbon.png"))
            using (var image = new Bitmap(stream))
                return new Bitmap(image);
        }

        internal static Icon WindowIcon()
        {
            using (var stream = typeof(AppBranding).Assembly.GetManifestResourceStream("wrAIter.Icon.ico"))
            using (var icon = new Icon(stream))
                return (Icon)icon.Clone();
        }

        internal static Bitmap DialogImage(int size)
        {
            using (var stream = typeof(AppBranding).Assembly.GetManifestResourceStream("wrAIter.Icon.ico"))
            using (var icon = new Icon(stream, size, size))
            {
                var image = new Bitmap(size, size, System.Drawing.Imaging.PixelFormat.Format32bppPArgb);
                try
                {
                    using (Graphics graphics = Graphics.FromImage(image))
                    {
                        graphics.Clear(Color.Transparent);
                        graphics.DrawIcon(icon, new Rectangle(0, 0, size, size));
                    }
                    return image;
                }
                catch { image.Dispose(); throw; }
            }
        }

        internal static void ApplyPalette(Control root, bool highContrast)
        {
            bool nativeControl = root is ButtonBase || root is TextBoxBase || root is ListControl;
            if (!nativeControl)
            {
                root.BackColor = highContrast ? SystemColors.Control : Color.FromArgb(251, 248, 239);
                root.ForeColor = highContrast ? SystemColors.ControlText : Color.FromArgb(27, 53, 48);
            }
            else root.ForeColor = root is ButtonBase ? SystemColors.ControlText : SystemColors.WindowText;
            foreach (Control child in root.Controls) ApplyPalette(child, highContrast);
        }
    }
}
