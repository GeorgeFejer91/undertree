using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace UnderTree.WordAddin
{
    internal sealed class TunnelProcess : IDisposable
    {
        private readonly string executable;
        private readonly string home;
        private readonly IntPtr job;
        private readonly object processGate = new object();
        private bool disposed;

        internal TunnelProcess(string executable, string home)
        {
            this.executable = System.IO.Path.GetFullPath(executable);
            this.home = home;
            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new Win32Exception();
            JobExtendedLimits limits = new JobExtendedLimits();
            limits.Basic.LimitFlags = 0x2000;
            int size = Marshal.SizeOf(typeof(JobExtendedLimits));
            IntPtr buffer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(limits, buffer, false);
                if (!SetInformationJobObject(job, 9, buffer, (uint)size)) throw new Win32Exception();
            }
            catch { CloseHandle(job); throw; }
            finally { Marshal.FreeHGlobal(buffer); }
        }

        internal Process Spawn(string[] arguments)
        {
            lock (processGate)
            {
                if (disposed) throw new ObjectDisposedException("Word connection runtime");
                return SpawnCore(arguments);
            }
        }

        private Process SpawnCore(string[] arguments)
        {
            ConnectionProfile.CheckPlain(executable);
            if (!File.Exists(executable)) throw new InvalidOperationException("The bundled Word connection runtime is missing. Repair this installation.");
            StringBuilder command = new StringBuilder();
            foreach (string argument in arguments)
            {
                if (command.Length > 0) command.Append(' ');
                command.Append(Quote(argument));
            }
            ProcessStartInfo start = new ProcessStartInfo(executable, command.ToString()) {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
                WorkingDirectory = home
            };
            start.EnvironmentVariables["HOME"] = home;
            start.EnvironmentVariables["USERPROFILE"] = home;
            string root = System.IO.Path.GetPathRoot(home);
            start.EnvironmentVariables["HOMEDRIVE"] = root.TrimEnd('\\');
            start.EnvironmentVariables["HOMEPATH"] = home.Substring(root.Length - 1);
            foreach (string key in start.EnvironmentVariables.Keys.Cast<string>().Where(key =>
                key.StartsWith("ZROK2_", StringComparison.OrdinalIgnoreCase) || key.StartsWith("ZROK_", StringComparison.OrdinalIgnoreCase)).ToArray())
                start.EnvironmentVariables.Remove(key);
            Process child = Process.Start(start);
            try
            {
                if (!AssignProcessToJobObject(job, child.Handle)) throw new Win32Exception();
                child.StandardInput.Close();
                return child;
            }
            catch { Kill(child); child.Dispose(); throw; }
        }

        internal string Run(string[] arguments, CancellationToken cancellation)
        {
            using (Process child = Spawn(arguments))
            {
                BoundedOutput output = new BoundedOutput(child.StandardOutput, child);
                BoundedOutput errors = new BoundedOutput(child.StandardError, child);
                Thread stdout = new Thread(output.Read) { IsBackground = true };
                Thread stderr = new Thread(errors.Read) { IsBackground = true };
                stdout.Start(); stderr.Start();
                try
                {
                    Stopwatch duration = Stopwatch.StartNew();
                    while (!child.WaitForExit(100))
                    {
                        cancellation.ThrowIfCancellationRequested();
                        if (duration.ElapsedMilliseconds > 20000) throw new InvalidOperationException("Word connection management timed out. Review its private enrollment and retry.");
                    }
                    if (!stdout.Join(2000) || !stderr.Join(2000) || output.Overflow || errors.Overflow || child.ExitCode != 0)
                        throw new InvalidOperationException("Word connection management failed. Check the account token and service; existing reservations were preserved.");
                    return output.Text;
                }
                finally { Kill(child); }
            }
        }

        internal static void Drain(Process child)
        {
            Thread stdout = new Thread(new BoundedOutput(child.StandardOutput, child).Discard) { IsBackground = true };
            Thread stderr = new Thread(new BoundedOutput(child.StandardError, child).Discard) { IsBackground = true };
            stdout.Start(); stderr.Start();
        }

        internal static void Kill(Process child)
        {
            if (child == null) return;
            try { if (!child.HasExited) child.Kill(); child.WaitForExit(2000); }
            catch (InvalidOperationException) { }
            catch (Win32Exception) { }
        }

        private static string Quote(string value)
        {
            if (value.IndexOf('\0') >= 0 || value.IndexOf('\r') >= 0 || value.IndexOf('\n') >= 0) throw new ArgumentException("Invalid process argument.");
            StringBuilder encoded = new StringBuilder("\"");
            int slashes = 0;
            foreach (char character in value)
            {
                if (character == '\\') { slashes++; continue; }
                encoded.Append('\\', character == '"' ? slashes * 2 + 1 : slashes);
                encoded.Append(character);
                slashes = 0;
            }
            encoded.Append('\\', slashes * 2);
            return encoded.Append('"').ToString();
        }

        private sealed class BoundedOutput
        {
            private readonly StreamReader source;
            private readonly Process child;
            private readonly StringBuilder text = new StringBuilder();
            internal bool Overflow;
            internal string Text { get { return text.ToString(); } }
            internal BoundedOutput(StreamReader source, Process child) { this.source = source; this.child = child; }
            internal void Read() { Consume(true); }
            internal void Discard() { Consume(false); }
            private void Consume(bool capture)
            {
                try
                {
                    char[] buffer = new char[2048];
                    int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        if (!capture) continue;
                        if (text.Length + count > 262144) { Overflow = true; Kill(child); return; }
                        text.Append(buffer, 0, count);
                    }
                }
                catch (IOException) { Overflow = true; }
                catch (ObjectDisposedException) { Overflow = true; }
            }
        }

        public void Dispose() { lock (processGate) { if (!disposed) { disposed = true; CloseHandle(job); } } }

        [StructLayout(LayoutKind.Sequential)]
        private struct JobBasicLimits
        {
            internal long ProcessTime, JobTime;
            internal uint LimitFlags;
            internal UIntPtr MinimumWorkingSet, MaximumWorkingSet;
            internal uint ActiveProcessLimit;
            internal UIntPtr Affinity;
            internal uint PriorityClass, SchedulingClass;
        }
        [StructLayout(LayoutKind.Sequential)]
        private struct JobIoCounters { internal ulong ReadOperations, WriteOperations, OtherOperations, ReadBytes, WriteBytes, OtherBytes; }
        [StructLayout(LayoutKind.Sequential)]
        private struct JobExtendedLimits
        {
            internal JobBasicLimits Basic;
            internal JobIoCounters Io;
            internal UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemory, PeakJobMemory;
        }
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        private static extern IntPtr CreateJobObject(IntPtr attributes, string name);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(IntPtr job, int informationClass, IntPtr information, uint length);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);
    }
}
