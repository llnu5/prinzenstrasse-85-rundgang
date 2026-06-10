// Dreihoch Metaverse - minimal Rhino plug-in (.rhp)
// Provides the commands "Publish" and "PublishUpload" (which run the bundled
// IronPython scripts) plus an auto-loading toolbar. Targets net48 -> loads in
// Rhino 6 (native) and Rhino 8 (compatibility).
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Rhino;
using Rhino.Commands;
using Rhino.PlugIns;

[assembly: PlugInDescription(DescriptionType.Organization, "Dreihoch")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://llnu5.github.io/dreihoch-metaverse/")]
[assembly: AssemblyTitle("Dreihoch Metaverse")]
[assembly: AssemblyDescription("Publish Rhino models to the Dreihoch Metaverse web viewer.")]
[assembly: AssemblyCompany("Dreihoch")]
[assembly: AssemblyProduct("Dreihoch Metaverse")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: Guid("a1b2c3d4-0000-4000-8000-000000000010")]

namespace DreihochMetaverse
{
    public class DreihochPlugIn : PlugIn
    {
        public DreihochPlugIn() { Instance = this; }
        public static DreihochPlugIn Instance { get; private set; }
    }

    internal static class Runner
    {
        public static void RunPy(string fileName)
        {
            try
            {
                string dir = Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location);
                string path = Path.Combine(dir, fileName);
                if (!File.Exists(path))
                {
                    RhinoApp.WriteLine("Dreihoch: script not found: " + path);
                    return;
                }
                RhinoApp.RunScript("_-RunPythonScript \"" + path + "\"", false);
            }
            catch (Exception ex)
            {
                RhinoApp.WriteLine("Dreihoch error: " + ex.Message);
            }
        }
    }

    [Guid("a1b2c3d4-0000-4000-8000-000000000011")]
    public class PublishCommand : Command
    {
        public override string EnglishName { get { return "Publish"; } }
        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            Runner.RunPy("rhino_publish.py");
            return Result.Success;
        }
    }

    [Guid("a1b2c3d4-0000-4000-8000-000000000012")]
    public class PublishUploadCommand : Command
    {
        public override string EnglishName { get { return "PublishUpload"; } }
        protected override Result RunCommand(RhinoDoc doc, RunMode mode)
        {
            Runner.RunPy("pr85_upload.py");
            return Result.Success;
        }
    }
}
