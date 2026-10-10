package batlehub.jdt.core;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.resources.IResource;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/**
 * The one delegate (RFC 0001 §6.2): `batlehub.ping`, `batlehub.generate.accessors`,
 * `batlehub.inspections.list`, `batlehub.inspections.fixAll`, `batlehub.completion.chain`
 * (RFC 0012 phase 2), `batlehub.rename` (RFC 0002 §5.3), `batlehub.refresh`,
 * `batlehub.generate.builder`, `batlehub.generate.withers` and `batlehub.generate.surroundWith` (RFC 0015). Arguments arrive
 * Gson-deserialised (Map/List/String); answers are plain maps and lists.
 */
public class Handler implements IDelegateCommandHandler {
  public static final String VERSION = "0.7.0";

  @Override
  public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
    switch (commandId) {
      case "batlehub.ping": {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", VERSION);
        out.put("inspections", Engine.inspections().stream().map(i -> i.area() + "/" + i.id()).toList());
        // RFC 0005 §6.3: each rule's declared severity, so a profile's downgrade is known for what it is.
        Map<String, String> defaults = new LinkedHashMap<>();
        for (Inspection i : Engine.inspections()) defaults.put(i.area() + "/" + i.id(), i.severity());
        out.put("defaults", defaults);
        // The core decides its fallbacks from this list, not from a failed call (RFC 0012 §4.3).
        out.put("commands", List.of("batlehub.generate.accessors", "batlehub.inspections.list", "batlehub.inspections.fixAll", "batlehub.completion.chain", "batlehub.rename", "batlehub.refresh", "batlehub.generate.builder", "batlehub.generate.withers", "batlehub.generate.surroundWith"));
        return out;
      }
      case "batlehub.completion.chain": {
        // (uri, line, character, budgetMs, maxDepth)
        String uri = String.valueOf(arguments.get(0));
        ICompilationUnit cu = JDTUtils.resolveCompilationUnit(uri);
        if (cu == null) throw new IllegalArgumentException("batlehub: not a Java compilation unit: " + uri);
        int offset = Engine.offsetOf(cu.getSource(), ((Number) arguments.get(1)).intValue(), ((Number) arguments.get(2)).intValue());
        long budget = arguments.size() > 3 ? ((Number) arguments.get(3)).longValue() : 150;
        int maxDepth = arguments.size() > 4 ? ((Number) arguments.get(4)).intValue() : 3;
        return Chains.find(cu, offset, budget, maxDepth);
      }
      case "batlehub.rename": {
        // (symbol, newName) or (uri, line, character, newName), 0-based like LSP.
        if (arguments.size() == 2) return Rename.symbol(String.valueOf(arguments.get(0)), String.valueOf(arguments.get(1)), monitor);
        return Rename.at(
            String.valueOf(arguments.get(0)),
            ((Number) arguments.get(1)).intValue(),
            ((Number) arguments.get(2)).intValue(),
            String.valueOf(arguments.get(3)),
            monitor);
      }
      case "batlehub.refresh": {
        // (uris) The engine's own writes, seen by its next call: didChangeWatchedFiles
        // is queued to a thread of JDT.LS's, so a call right after it reads the old file.
        int n = 0;
        for (Object u : (List<?>) arguments.get(0)) {
          ICompilationUnit cu = JDTUtils.resolveCompilationUnit(String.valueOf(u));
          if (cu == null) continue;
          IResource r = cu.getResource();
          if (r != null) r.refreshLocal(IResource.DEPTH_ZERO, monitor);
          if (!cu.isWorkingCopy()) cu.close(); // the cached buffer and members go; the next read is the file's
          n++;
        }
        return Map.of("refreshed", n);
      }
      case "batlehub.inspections.list": {
        String uri = String.valueOf(arguments.get(0));
        return Engine.list(source(uri));
      }
      case "batlehub.inspections.fixAll": {
        String uri = String.valueOf(arguments.get(0));
        String rule = arguments.size() > 1 && arguments.get(1) != null ? String.valueOf(arguments.get(1)) : null;
        // (uri, ruleId | null, skip?) skip: the ruleIds a bulk fix leaves alone.
        java.util.Set<String> skip = new java.util.HashSet<>();
        if (arguments.size() > 2 && arguments.get(2) instanceof List<?> l) for (Object o : l) skip.add(String.valueOf(o));
        return workspaceEdit(uri, Engine.fixAll(source(uri), rule, skip));
      }
      case "batlehub.generate.surroundWith": {
        // (uri, LSP range, options JSON). Bindings from the working copy when there is one:
        // they give the precise catch type; without, `Exception` and a note (§4.2).
        String uri = String.valueOf(arguments.get(0));
        @SuppressWarnings("unchecked")
        Map<String, Object> range = (Map<String, Object>) arguments.get(1);
        Map<String, Object> options = arguments.size() > 2 ? parseOptions(arguments.get(2)) : Map.of();
        ICompilationUnit icu = JDTUtils.resolveCompilationUnit(uri);
        if (icu == null) throw new IllegalArgumentException("batlehub: not a Java compilation unit: " + uri);
        String src = icu.getSource();
        CompilationUnit cu = Engine.parse(icu);
        @SuppressWarnings("unchecked")
        Map<String, Object> a = (Map<String, Object>) range.get("start"), b = (Map<String, Object>) range.get("end");
        int start = Engine.offsetOf(src, ((Number) a.get("line")).intValue(), ((Number) a.get("character")).intValue());
        int end = Engine.offsetOf(src, ((Number) b.get("line")).intValue(), ((Number) b.get("character")).intValue());
        Map<String, Object> out = generated(uri, src, Surround.wrap(cu, src, start, end, Surround.Options.of(options), Engine.indentUnit(src)));
        if (cu.getAST().hasResolvedBindings()) return out;
        Map<String, Object> noted = new LinkedHashMap<>(out);
        noted.put("note", "surround: no bindings, catch type is Exception");
        return noted;
      }
      case "batlehub.generate.builder":
      case "batlehub.generate.withers": {
        // (CodeActionParams, options JSON) like the accessors; a refusal is an answer, not an exception (§6.1).
        @SuppressWarnings("unchecked")
        Map<String, Object> params = (Map<String, Object>) arguments.get(0);
        @SuppressWarnings("unchecked")
        String uri = String.valueOf(((Map<String, Object>) params.get("textDocument")).get("uri"));
        Map<String, Object> options = arguments.size() > 1 ? parseOptions(arguments.get(1)) : Map.of();
        String src = source(uri);
        CompilationUnit cu = Engine.parse(src);
        @SuppressWarnings("unchecked")
        Map<String, Object> start = (Map<String, Object>) ((Map<String, Object>) params.get("range")).get("start");
        int offset = Engine.offsetOf(src, ((Number) start.get("line")).intValue(), ((Number) start.get("character")).intValue());
        String indent = Engine.indentUnit(src);
        Builders.Result r = commandId.endsWith("builder")
            ? Builders.build(cu, offset, Builders.Options.of(options), indent)
            : Withers.build(cu, offset, Withers.Options.of(options), indent);
        return generated(uri, src, r);
      }
      case "batlehub.generate.accessors": {
        @SuppressWarnings("unchecked")
        Map<String, Object> params = (Map<String, Object>) arguments.get(0);
        @SuppressWarnings("unchecked")
        String uri = String.valueOf(((Map<String, Object>) params.get("textDocument")).get("uri"));
        Map<String, Object> options = arguments.size() > 1 ? parseOptions(arguments.get(1)) : Map.of();
        String src = source(uri);
        CompilationUnit cu = Engine.parse(src);
        @SuppressWarnings("unchecked")
        Map<String, Object> start = (Map<String, Object>) ((Map<String, Object>) params.get("range")).get("start");
        int offset = Engine.offsetOf(src, ((Number) start.get("line")).intValue(), ((Number) start.get("character")).intValue());
        ASTRewrite rewrite = Accessors.rewrite(cu, offset, Accessors.Options.of(options), Engine.indentUnit(src));
        return workspaceEdit(uri, Engine.edits(src, rewrite));
      }
      default:
        throw new UnsupportedOperationException("batlehub: unknown command " + commandId);
    }
  }

  @SuppressWarnings("unchecked")
  /** A generator's answer: its refusal, the edit, or — for a builder in its own file — the file to create beside the type. */
  private static Map<String, Object> generated(String uri, String src, Builders.Result r) {
    if (r.refused() != null) {
      Map<String, Object> out = workspaceEdit(uri, List.of());
      out.put("refused", r.refused());
      return out;
    }
    List<Map<String, Object>> edits = Engine.edits(src, r.rewrite());
    if (r.newFile() == null) return workspaceEdit(uri, edits);
    String target = uri.substring(0, uri.lastIndexOf('/') + 1) + r.newFile();
    if (java.nio.file.Files.exists(java.nio.file.Path.of(java.net.URI.create(target)))) {
      Map<String, Object> out = workspaceEdit(uri, List.of());
      out.put("refused", "batlehub: " + r.newFile() + " already exists beside the type; choose the inner placement");
      return out;
    }
    Map<String, Object> zero = Map.of("line", 0, "character", 0);
    return Map.of("documentChanges", List.of(
        Map.of("kind", "create", "uri", target),
        Map.of("textDocument", textDocument(target), "edits", List.of(Map.of("range", Map.of("start", zero, "end", zero), "newText", r.newText()))),
        Map.of("textDocument", textDocument(uri), "edits", edits)));
  }

  private static Map<String, Object> textDocument(String uri) {
    Map<String, Object> d = new LinkedHashMap<>();
    d.put("uri", uri);
    d.put("version", null);
    return d;
  }

  private static Map<String, Object> parseOptions(Object o) {
    if (o instanceof Map<?, ?> m) return (Map<String, Object>) m;
    return new com.google.gson.Gson().fromJson(String.valueOf(o), Map.class);
  }

  private static String source(String uri) throws Exception {
    ICompilationUnit cu = JDTUtils.resolveCompilationUnit(uri);
    if (cu == null) throw new IllegalArgumentException("batlehub: not a Java compilation unit: " + uri);
    return cu.getSource();
  }

  private static Map<String, Object> workspaceEdit(String uri, List<Map<String, Object>> edits) {
    Map<String, Object> changes = new LinkedHashMap<>();
    changes.put(uri, edits);
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("changes", changes);
    return out;
  }
}
