package batlehub.jdt.core;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.rewrite.ASTRewrite;
import org.eclipse.jdt.ls.core.internal.IDelegateCommandHandler;
import org.eclipse.jdt.ls.core.internal.JDTUtils;

/**
 * The one delegate (RFC 0001 §6.2): `batlehub.ping`, `batlehub.generate.accessors`,
 * `batlehub.inspections.list`, `batlehub.inspections.fixAll`, `batlehub.completion.chain`
 * (RFC 0012 phase 2). Arguments arrive
 * Gson-deserialised (Map/List/String); answers are plain maps and lists.
 */
public class Handler implements IDelegateCommandHandler {
  public static final String VERSION = "0.2.1";

  @Override
  public Object executeCommand(String commandId, List<Object> arguments, IProgressMonitor monitor) throws Exception {
    switch (commandId) {
      case "batlehub.ping": {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("version", VERSION);
        out.put("inspections", Engine.inspections().stream().map(i -> i.area() + "/" + i.id()).toList());
        // The core decides its fallbacks from this list, not from a failed call (RFC 0012 §4.3).
        out.put("commands", List.of("batlehub.generate.accessors", "batlehub.inspections.list", "batlehub.inspections.fixAll", "batlehub.completion.chain"));
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
      case "batlehub.inspections.list": {
        String uri = String.valueOf(arguments.get(0));
        return Engine.list(source(uri));
      }
      case "batlehub.inspections.fixAll": {
        String uri = String.valueOf(arguments.get(0));
        String rule = arguments.size() > 1 && arguments.get(1) != null ? String.valueOf(arguments.get(1)) : null;
        return workspaceEdit(uri, Engine.fixAll(source(uri), rule));
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
