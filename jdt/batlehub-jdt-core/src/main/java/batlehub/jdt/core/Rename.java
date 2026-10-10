package batlehub.jdt.core;

import java.util.ArrayList;
import java.util.List;
import org.eclipse.core.resources.ResourcesPlugin;
import org.eclipse.core.runtime.IProgressMonitor;
import org.eclipse.jdt.core.ICompilationUnit;
import org.eclipse.jdt.core.IField;
import org.eclipse.jdt.core.IJavaElement;
import org.eclipse.jdt.core.IJavaProject;
import org.eclipse.jdt.core.IMember;
import org.eclipse.jdt.core.IMethod;
import org.eclipse.jdt.core.IType;
import org.eclipse.jdt.core.JavaCore;
import org.eclipse.jdt.core.JavaModelException;
import org.eclipse.jdt.ls.core.internal.JDTUtils;
import org.eclipse.jdt.ls.core.internal.JavaLanguageServerPlugin;
import org.eclipse.jdt.ls.core.internal.handlers.RenameHandler;
import org.eclipse.lsp4j.Position;
import org.eclipse.lsp4j.RenameParams;
import org.eclipse.lsp4j.TextDocumentIdentifier;
import org.eclipse.lsp4j.WorkspaceEdit;

/**
 * `batlehub.rename` (RFC 0002 §5.3): a rename for callers without a cursor.
 * It runs JDT.LS's own RenameHandler — the code behind `textDocument/rename`,
 * so the editor's F2 and this delegate cannot disagree (decision 22). The
 * symbol form `Fully.Qualified.Type#member` is resolved here, in the Java
 * model, so a caller makes one call. A file's primary type is refused: its
 * rename moves the file, and a client without resource operations would get
 * the text edits alone — the class renamed in a file of the old name.
 */
final class Rename {
  private Rename() {}

  /** `a.b.C#m` → {`a.b.C`, `m`}; `a.b.C` → {`a.b.C`, null}. */
  static String[] parse(String symbol) {
    if (!symbol.matches("[\\p{L}_$][\\p{L}\\p{N}_$]*(\\.[\\p{L}_$][\\p{L}\\p{N}_$]*)*(#[\\p{L}_$][\\p{L}\\p{N}_$]*)?"))
      throw new IllegalArgumentException("batlehub: " + symbol + " is not Fully.Qualified.Type[#member]");
    int hash = symbol.indexOf('#');
    return hash < 0 ? new String[] {symbol, null} : new String[] {symbol.substring(0, hash), symbol.substring(hash + 1)};
  }

  static WorkspaceEdit symbol(String symbol, String newName, IProgressMonitor monitor) throws JavaModelException {
    String[] parts = parse(symbol);
    IType type = null;
    for (IJavaProject p : JavaCore.create(ResourcesPlugin.getWorkspace().getRoot()).getJavaProjects()) {
      IType t = p.findType(parts[0]);
      if (t != null && !t.isBinary()) {
        type = t;
        break;
      }
    }
    if (type == null) throw new IllegalArgumentException("batlehub: no type " + parts[0] + " in the workspace's sources");
    IMember target = type;
    if (parts[1] != null) {
      List<IMember> found = new ArrayList<>();
      for (IMethod m : type.getMethods()) if (m.getElementName().equals(parts[1])) found.add(m);
      IField f = type.getField(parts[1]);
      if (f.exists()) found.add(f);
      if (found.isEmpty()) throw new IllegalArgumentException("batlehub: no member " + parts[1] + " in " + parts[0]);
      if (found.size() > 1) {
        List<String> names = new ArrayList<>();
        for (IMember m : found) names.add(m instanceof IMethod im ? im.getElementName() + "(" + String.join(", ", im.getParameterTypes()) + ")" : m.getElementName());
        throw new IllegalArgumentException("batlehub: " + symbol + " is ambiguous (" + String.join("; ", names) + "): use path:line:col");
      }
      target = found.get(0);
    }
    ICompilationUnit cu = target.getCompilationUnit();
    Position at = JDTUtils.toRange(cu, target.getNameRange().getOffset(), target.getNameRange().getLength()).getStart();
    return at(JDTUtils.toURI(cu), at.getLine(), at.getCharacter(), newName, monitor);
  }

  static WorkspaceEdit at(String uri, int line, int character, String newName, IProgressMonitor monitor) throws JavaModelException {
    // Every open buffer reconciled first: JDT refuses a rename on a unit whose
    // structure is unknown, and a buffer typed into just before the call (an
    // agent beside a developer) can be left at the state of a mid-typing
    // reconcile — "syntax errors in the compilation unit" with none on screen.
    for (ICompilationUnit wc : JavaCore.getWorkingCopies(null)) wc.reconcile(ICompilationUnit.NO_AST, false, null, monitor);
    ICompilationUnit cu = JDTUtils.resolveCompilationUnit(uri);
    if (cu == null) throw new IllegalArgumentException("batlehub: not a Java compilation unit: " + uri);
    IType primary = cu.findPrimaryType();
    for (IJavaElement e : cu.codeSelect(Engine.offsetOf(cu.getSource(), line, character), 0))
      if (primary != null && primary.equals(e))
        throw new IllegalArgumentException(
            "batlehub: renaming " + primary.getFullyQualifiedName() + " moves its file (" + cu.getElementName() + "), which a headless rename does not do: rename it in the editor");
    RenameParams params = new RenameParams(new TextDocumentIdentifier(uri), new Position(line, character), newName);
    return new RenameHandler(JavaLanguageServerPlugin.getPreferencesManager()).rename(params, monitor);
  }
}
