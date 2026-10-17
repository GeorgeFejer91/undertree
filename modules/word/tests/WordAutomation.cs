using System;
using System.Runtime.InteropServices;

[ComImport, Guid("00000016-0000-0000-C000-000000000046"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IWordTestMessageFilter
{
    [PreserveSig] int HandleInComingCall(int type, IntPtr caller, int elapsed, IntPtr info);
    [PreserveSig] int RetryRejectedCall(IntPtr callee, int elapsed, int rejection);
    [PreserveSig] int MessagePending(IntPtr callee, int elapsed, int pending);
}

public sealed class WordTestAutomation : IWordTestMessageFilter, IDisposable
{
    private IWordTestMessageFilter previous;
    [DllImport("ole32.dll")] private static extern int CoRegisterMessageFilter(IWordTestMessageFilter filter, out IWordTestMessageFilter old);
    public WordTestAutomation() { Marshal.ThrowExceptionForHR(CoRegisterMessageFilter(this, out previous)); }
    public int HandleInComingCall(int type, IntPtr caller, int elapsed, IntPtr info) { return 0; }
    public int RetryRejectedCall(IntPtr callee, int elapsed, int rejection)
    { return elapsed < 10000 && (rejection == 1 || rejection == 2) ? 100 : -1; }
    public int MessagePending(IntPtr callee, int elapsed, int pending) { return 2; }
    public static string Read(object value) { dynamic document = value; return (string)document.Content.Text; }
    public static int Italic(object value, int from, int to) { dynamic document = value; return (int)document.Range(from, to).Font.Italic; }
    public void Dispose() { IWordTestMessageFilter ignored; Marshal.ThrowExceptionForHR(CoRegisterMessageFilter(previous, out ignored)); }
}
