// Dreihoch Metaverse -- Rhino plug-in (thin wrapper around the Python tools)
// Registers the commands "Publish" and "PublishUpload" and ships a toolbar.
// Built for .NET Framework 4.8 against RhinoCommon 6 -> loads in Rhino 6, 7 and 8.
using System;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using Rhino;
using Rhino.Commands;
using Rhino.PlugIns;

[assembly: AssemblyTitle("Dreihoch Metaverse")]
[assembly: AssemblyDescription("Publish Rhino models to the Dreihoch Metaverse web viewer.")]
[assembly: AssemblyCompany("Dreihoch")]
[assembly: AssemblyProduct("DreihochMetaverse")]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]
[assembly: Guid("e7b9c2a4-3d51-4f86-9a2e-1c0d8f4b7a10")]
[assembly: PlugInDescription(DescriptionType.Organization, "Dreihoch")]
[assembly: PlugInDescription(DescriptionType.WebSite, "https://llnu5.github.io/dreihoch-metaverse/")]

namespace DreihochMetaverse
{
  public class DreihochMetaversePlugIn : PlugIn
  {
    public DreihochMetaversePlugIn() { Instance = this; }
    public static DreihochMetaversePlugIn Instance { get; private set; }

    public static string PluginDir
    {
      get
      {
        try { return Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location); }
        catch { return null; }
      }
    }

    public static void RunPy(string fileName)
    {
      try
      {
        string dir = PluginDir;
        string p = (dir != null) ? Path.Combine(dir, fileName) : fileName;
        if (File.Exists(p))
          RhinoApp.RunScript("_-RunPythonScript \"" + p + "\"", false);
        else
          RhinoApp.WriteLine("[Dreihoch] script not found: " + p);
      }
      catch (Exception ex) { RhinoApp.WriteLine("[Dreihoch] " + ex.Message); }
    }
  }

  [Guid("a1b2c3d4-0001-4000-8000-000000000001")]
  public class PublishCommand : Command
  {
    public override string EnglishName { get { return "Publish"; } }
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
      DreihochMetaversePlugIn.RunPy("rhino_publish.py");
      return Result.Success;
    }
  }

  [Guid("a1b2c3d4-0002-4000-8000-000000000002")]
  public class PublishUploadCommand : Command
  {
    public override string EnglishName { get { return "PublishUpload"; } }
    protected override Result RunCommand(RhinoDoc doc, RunMode mode)
    {
      DreihochMetaversePlugIn.RunPy("pr85_upload.py");
      return Result.Success;
    }
  }
}
