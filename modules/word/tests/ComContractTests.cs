using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using UnderTree.WordAddin;

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class ComContractSentinel
{
    public string Name { get { return "Native argument identity"; } }
}

public sealed class RibbonControlSentinel
{
    public string Tag { get { return "0"; } }
}

[ComVisible(true), ClassInterface(ClassInterfaceType.None)]
public sealed class ComContractCallbacks : IOfficeLifecycle, IOfficeRibbon
{
    public int Calls;
    public object Application, Addin;
    public int? ExpectedArrayLength = 1;

    public void OnConnection(object application, int mode, object addin, ref Array custom)
    {
        if (mode != 7 || !Object.ReferenceEquals(application, Application) || !Object.ReferenceEquals(addin, Addin))
            throw new InvalidOperationException("Native connection arguments lost their identities or Int32 mode.");
        CheckArray(custom);
        Calls++;
    }

    public void OnDisconnection(int mode, ref Array custom)
    {
        if (mode != 9) throw new InvalidOperationException("Native disconnect mode changed.");
        CheckArray(custom);
        Calls++;
    }

    public void OnAddInsUpdate(ref Array custom) { CheckArray(custom); Calls++; }
    public void OnStartupComplete(ref Array custom) { CheckArray(custom); Calls++; }
    public void OnBeginShutdown(ref Array custom) { CheckArray(custom); Calls++; }

    public string GetCustomUI(string ribbonId)
    {
        if (ribbonId != "Word.Document.12") throw new InvalidOperationException("Ribbon BSTR argument changed.");
        return "<customUI/>";
    }

    private void CheckArray(Array custom)
    {
        if (!ExpectedArrayLength.HasValue)
        {
            if (custom != null) throw new InvalidOperationException("Null native SAFEARRAY did not remain null.");
            return;
        }
        if (custom == null || custom.Length != ExpectedArrayLength.Value || custom.Rank != 1 || custom.GetLowerBound(0) != 0 ||
            (custom.Length != 0 && !Object.Equals(custom.GetValue(0), "native variant")))
            throw new InvalidOperationException("SAFEARRAY(VARIANT)** shape or native element changed.");
    }
}

internal static class ComContractTests
{
    private static int assertions;
    [DllImport("oleaut32.dll")] private static extern IntPtr SafeArrayCreateVector(ushort type, int lower, uint count);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayDestroy(IntPtr array);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayAccessData(IntPtr array, out IntPtr values);
    [DllImport("oleaut32.dll")] private static extern int SafeArrayUnaccessData(IntPtr array);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Connection(IntPtr self, IntPtr app, int mode, IntPtr addin, ref IntPtr custom);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Disconnect(IntPtr self, int mode, ref IntPtr custom);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Callback(IntPtr self, ref IntPtr custom);
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] private delegate int Ribbon(IntPtr self, IntPtr ribbonId, out IntPtr result);

    public static int Main(string[] arguments)
    {
        try
        {
            CheckInterface(typeof(IOfficeLifecycle), new Guid("B65AD801-ABAF-11D0-BB8B-00A0C90F2744"));
            CheckInterface(typeof(IOfficeRibbon), new Guid("000C0396-0000-0000-C000-000000000046"));
            if (arguments.Length != 0) Equal(arguments[0].ToLowerInvariant(), AssemblyHash(), "The test must load the exact requested add-in bytes.");
            CheckLifecycle();
            CheckRibbon();
            CheckRibbonCallbacks();
            CheckCachedPalette();
            CheckCompactPaletteXml();
            Console.WriteLine("COM metadata assertions passed. Beginning safe native ABI callbacks.");
            NativeCallbacks();
            Console.WriteLine("Word COM contract: " + assertions + " assertions passed; all five lifecycle callbacks and ribbon native roundtrip passed.");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("ASSERTION FAILURE: " + error.Message);
            return 1;
        }
    }

    private static void CheckInterface(Type type, Guid expectedGuid)
    {
        Equal(true, type.IsInterface && type.IsPublic, type.Name + " must be a public interface.");
        Equal(expectedGuid, type.GUID, type.Name + " must retain Office's canonical IID.");
        Equal(true, type.IsImport, type.Name + " must be declared ComImport.");
        var kind = (InterfaceTypeAttribute)Attribute.GetCustomAttribute(type, typeof(InterfaceTypeAttribute));
        Equal(ComInterfaceType.InterfaceIsDual, kind == null ? ComInterfaceType.InterfaceIsDual : kind.Value,
            type.Name + " must be a dual interface before any native vtable invocation.");
    }

    private static void CheckLifecycle()
    {
        var names = new[] { "OnConnection", "OnDisconnection", "OnAddInsUpdate", "OnStartupComplete", "OnBeginShutdown" };
        var counts = new[] { 4, 2, 1, 1, 1 };
        for (int index = 0; index < names.Length; index++)
        {
            MethodInfo method = typeof(IOfficeLifecycle).GetMethod(names[index]);
            CheckMethod(method, index + 1, index + 7);
            Equal(typeof(void), method.ReturnType, names[index] + " must return HRESULT through normal COM conversion.");
            ParameterInfo[] parameters = method.GetParameters();
            Equal(counts[index], parameters.Length, names[index] + " parameter count.");
            ParameterInfo custom = parameters[parameters.Length - 1];
            Equal(typeof(Array).MakeByRefType(), custom.ParameterType, names[index] + " must accept ref Array.");
            Equal(true, custom.IsIn && !custom.IsOut, names[index] + " custom array must be [In].");
            MarshalAsAttribute array = Marshalling(custom);
            Equal(UnmanagedType.SafeArray, array.Value, names[index] + " must marshal a SAFEARRAY.");
            Equal(VarEnum.VT_VARIANT, array.SafeArraySubType, names[index] + " must marshal SAFEARRAY(VARIANT).");
            if (index == 0)
            {
                Equal(typeof(object), parameters[0].ParameterType, "Application must be an IDispatch object.");
                Equal(UnmanagedType.IDispatch, Marshalling(parameters[0]).Value, "Application IDispatch marshaling.");
                Equal(typeof(int), parameters[1].ParameterType, "Connect mode must retain its native Int32 ABI.");
                Equal(typeof(object), parameters[2].ParameterType, "Add-in instance must be an IDispatch object.");
                Equal(UnmanagedType.IDispatch, Marshalling(parameters[2]).Value, "Add-in instance IDispatch marshaling.");
            }
            if (index == 1) Equal(typeof(int), parameters[0].ParameterType, "Disconnect mode must retain its native Int32 ABI.");
        }
    }

    private static void CheckRibbon()
    {
        MethodInfo method = typeof(IOfficeRibbon).GetMethod("GetCustomUI");
        CheckMethod(method, 1, 7);
        Equal(typeof(string), method.ReturnType, "Ribbon return type.");
        Equal(UnmanagedType.BStr, Marshalling(method.ReturnParameter).Value, "Ribbon return must be a BSTR.");
        ParameterInfo[] parameters = method.GetParameters();
        Equal(1, parameters.Length, "Ribbon parameter count.");
        Equal(typeof(string), parameters[0].ParameterType, "Ribbon ID type.");
        Equal(UnmanagedType.BStr, Marshalling(parameters[0]).Value, "Ribbon ID must be a BSTR.");
    }

    private static void CheckRibbonCallbacks()
    {
        var callbacks = new[] { "RibbonLoaded", "RibbonColorImage", "RibbonColorLabel", "RibbonColorEnabled", "RibbonColor", "RibbonNextColors", "RibbonColorRules", "RibbonSelectionRules" };
        var ids = new HashSet<int>();
        foreach (MethodInfo method in typeof(IWordEditorAutomation).GetMethods())
        {
            var id = (DispIdAttribute)Attribute.GetCustomAttribute(method, typeof(DispIdAttribute));
            Equal(true, id != null && ids.Add(id.Value), "Automation methods must have unique explicit dispatch IDs.");
        }
        foreach (string callback in callbacks)
        {
            MethodInfo method = typeof(IWordEditorAutomation).GetMethod(callback);
            Equal(true, method != null, callback + " must be exposed to Office dispatch.");
            Equal(1, method.GetParameters().Length, callback + " callback parameter count.");
            Equal(UnmanagedType.IDispatch, Marshalling(method.GetParameters()[0]).Value, callback + " callback object marshaling.");
        }
        Equal(typeof(bool), typeof(IWordEditorAutomation).GetMethod("RibbonColorEnabled").ReturnType, "Native enable callback returns Boolean.");
        Equal(UnmanagedType.IDispatch, Marshalling(typeof(IWordEditorAutomation).GetMethod("RibbonColorImage").ReturnParameter).Value,
            "Native swatch must return an IPictureDisp-compatible dispatch object.");
    }

    private static void CheckCachedPalette()
    {
        Type type = typeof(IWordEditorAutomation).Assembly.GetType("UnderTree.WordAddin.WordRibbon", true);
        int authorityCalls = 0;
        Func<string, IDictionary<string, object>, object> forbidden = delegate { authorityCalls++; throw new InvalidOperationException("Authority called from ribbon read callback."); };
        object palette = Activator.CreateInstance(type, BindingFlags.Instance | BindingFlags.NonPublic, null, new object[] { forbidden }, null);
        var state = new Dictionary<string, object> { { "rules", new object[] { new Dictionary<string, object> {
            { "id", "rule1" }, { "label", "Proofread" }, { "color", "#ffff00" }
        } } } };
        type.GetMethod("Observe", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(palette, new object[] { state });
        object[] control = { new RibbonControlSentinel() };
        Equal("Highlight selection: Proofread. Double-click to configure this color.", type.GetMethod("Label", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(palette, control), "Palette label comes from cached rule and explains its direct configuration gesture.");
        Equal(true, type.GetMethod("Enabled", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(palette, control), "Cached palette enables occupied slot.");
        object picture = type.GetMethod("Image", BindingFlags.Instance | BindingFlags.NonPublic).Invoke(palette, control);
        Equal(true, picture != null, "Cached swatch produces native image.");
        if (Marshal.IsComObject(picture)) Marshal.ReleaseComObject(picture);
        Equal(0, authorityCalls, "Office ribbon read callbacks must never enter document authority.");
    }

    private static void CheckCompactPaletteXml()
    {
        Type type = typeof(IWordEditorAutomation).Assembly.GetType("UnderTree.WordAddin.WordRibbon", true);
        foreach (string suffix in new[] { "Home", "Tab" })
        {
            string source = (string)type.GetMethod("GroupXml", BindingFlags.Static | BindingFlags.NonPublic).Invoke(null, new object[] { suffix });
            var xml = new System.Xml.XmlDocument();
            xml.LoadXml(source);
            Equal("", xml.DocumentElement.GetAttribute("label").Trim(), "Palette group has no visible caption.");
            System.Xml.XmlNodeList buttons = xml.SelectNodes("//button");
            Equal(27, buttons.Count, "Palette exposes all 24 colors and three explicit actions.");
            Equal(8, xml.SelectNodes("//box[starts-with(@id, 'wrAIterColorColumn')]").Count, "All 24 swatches use eight compact native columns.");
            Equal(24, xml.SelectNodes("//button[@onAction='RibbonColor']").Count, "Every color has a direct ribbon button.");
            Equal(0, xml.SelectNodes("//button[@onAction='RibbonNextColors' or @onAction='RibbonOpen']").Count, "The ribbon has no paged palette or unified-editor action.");
            Equal(1, xml.SelectNodes("//button[@label='New color rule']").Count, "New color opens one rule definition.");
            foreach (System.Xml.XmlElement button in buttons)
            {
                Equal("normal", button.GetAttribute("size"), "Palette uses small native controls.");
                Equal("false", button.GetAttribute("showLabel"), "Palette controls have no visible text.");
                Equal("true", button.GetAttribute("showImage"), "Palette controls display icons.");
                Equal(true, button.GetAttribute("keytip").Length > 0, "Icon-only controls retain keyboard access.");
                Equal(true, button.HasAttribute("getLabel") || button.GetAttribute("label").Length > 0, "Icon-only controls retain accessible names.");
                Equal(true, button.HasAttribute("getScreentip") || button.GetAttribute("screentip").Length > 0, "Icon-only controls retain tooltips.");
                Equal(true, button.HasAttribute("getImage") || button.GetAttribute("imageMso").Length > 0, "Icon-only controls have an image source.");
            }
        }
    }

    private static void CheckMethod(MethodInfo method, int dispId, int slot)
    {
        Equal(true, method != null, "Canonical COM method must exist.");
        var id = (DispIdAttribute)Attribute.GetCustomAttribute(method, typeof(DispIdAttribute));
        Equal(true, id != null, method.Name + " must have an explicit dispatch ID.");
        Equal(dispId, id.Value, method.Name + " dispatch ID.");
        Equal(false, method.IsDefined(typeof(PreserveSigAttribute), false), method.Name + " must translate its HRESULT.");
        Equal(slot, Marshal.GetComSlotForMethodInfo(method), method.Name + " must retain its canonical dual vtable slot.");
    }

    private static MarshalAsAttribute Marshalling(ParameterInfo parameter)
    {
        var attribute = (MarshalAsAttribute)Attribute.GetCustomAttribute(parameter, typeof(MarshalAsAttribute));
        Equal(true, attribute != null, parameter.Name + " must declare its native marshaling.");
        return attribute;
    }

    private static void NativeCallbacks()
    {
        var callbacks = new ComContractCallbacks { Application = new ComContractSentinel(), Addin = new ComContractSentinel() };
        IntPtr lifecycle = Marshal.GetComInterfaceForObject(callbacks, typeof(IOfficeLifecycle));
        IntPtr ribbon = Marshal.GetComInterfaceForObject(callbacks, typeof(IOfficeRibbon));
        IntPtr application = Marshal.GetIDispatchForObject(callbacks.Application);
        IntPtr addin = Marshal.GetIDispatchForObject(callbacks.Addin);
        IntPtr custom = SafeArrayCreateVector(12, 0, 1);
        IntPtr ribbonId = Marshal.StringToBSTR("Word.Document.12");
        IntPtr result = IntPtr.Zero;
        try
        {
            Equal(true, custom != IntPtr.Zero, "Native SAFEARRAY allocation.");
            IntPtr values;
            Marshal.ThrowExceptionForHR(SafeArrayAccessData(custom, out values));
            try { Marshal.GetNativeVariantForObject("native variant", values); }
            finally { Marshal.ThrowExceptionForHR(SafeArrayUnaccessData(custom)); }
            Marshal.ThrowExceptionForHR(((Connection)Slot(lifecycle, 7, typeof(Connection)))(lifecycle, application, 7, addin, ref custom));
            Marshal.ThrowExceptionForHR(((Disconnect)Slot(lifecycle, 8, typeof(Disconnect)))(lifecycle, 9, ref custom));
            for (int slot = 9; slot <= 11; slot++) Marshal.ThrowExceptionForHR(((Callback)Slot(lifecycle, slot, typeof(Callback)))(lifecycle, ref custom));
            Equal(5, callbacks.Calls, "Every lifecycle native vtable callback must reach the managed object exactly once.");
            Marshal.ThrowExceptionForHR(((Ribbon)Slot(ribbon, 7, typeof(Ribbon)))(ribbon, ribbonId, out result));
            Equal("<customUI/>", Marshal.PtrToStringBSTR(result), "Ribbon native BSTR return.");
            Marshal.ThrowExceptionForHR(SafeArrayDestroy(custom));
            custom = IntPtr.Zero;
            callbacks.ExpectedArrayLength = null;
            Marshal.ThrowExceptionForHR(((Connection)Slot(lifecycle, 7, typeof(Connection)))(lifecycle, application, 7, addin, ref custom));
            Equal(6, callbacks.Calls, "Null SAFEARRAY callback.");
            custom = SafeArrayCreateVector(12, 0, 0);
            Equal(true, custom != IntPtr.Zero, "Empty native SAFEARRAY allocation.");
            callbacks.ExpectedArrayLength = 0;
            Marshal.ThrowExceptionForHR(((Connection)Slot(lifecycle, 7, typeof(Connection)))(lifecycle, application, 7, addin, ref custom));
            Equal(7, callbacks.Calls, "Empty SAFEARRAY callback.");
        }
        finally
        {
            if (result != IntPtr.Zero) Marshal.FreeBSTR(result);
            Marshal.FreeBSTR(ribbonId);
            if (custom != IntPtr.Zero) SafeArrayDestroy(custom);
            Marshal.Release(addin);
            Marshal.Release(application);
            Marshal.Release(ribbon);
            Marshal.Release(lifecycle);
        }
    }

    private static Delegate Slot(IntPtr pointer, int slot, Type type)
    {
        return Marshal.GetDelegateForFunctionPointer(Marshal.ReadIntPtr(Marshal.ReadIntPtr(pointer), slot * IntPtr.Size), type);
    }

    private static string AssemblyHash()
    {
        using (var stream = File.OpenRead(typeof(IOfficeLifecycle).Assembly.Location))
        using (var hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
    }

    private static void Equal<T>(T expected, T actual, string message)
    {
        assertions++;
        if (!EqualityComparer<T>.Default.Equals(expected, actual)) throw new InvalidOperationException(message);
    }
}
