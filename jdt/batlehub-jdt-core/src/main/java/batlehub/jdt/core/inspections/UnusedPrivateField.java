package batlehub.jdt.core.inspections;

import batlehub.jdt.core.Finding;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.eclipse.jdt.core.dom.ASTVisitor;
import org.eclipse.jdt.core.dom.CompilationUnit;
import org.eclipse.jdt.core.dom.FieldDeclaration;
import org.eclipse.jdt.core.dom.Modifier;
import org.eclipse.jdt.core.dom.SimpleName;
import org.eclipse.jdt.core.dom.VariableDeclarationFragment;

/** A private field whose name occurs nowhere else in the file. Syntactic: a same-named local would hide it; that is the ceiling. */
public final class UnusedPrivateField extends Base {
  public UnusedPrivateField() {
    super("unused", "privateField", "warning");
  }

  @Override
  public void visit(CompilationUnit cu, List<Finding> out) {
    Map<String, Integer> uses = new HashMap<>();
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(SimpleName n) {
        uses.merge(n.getIdentifier(), 1, Integer::sum);
        return true;
      }
    });
    cu.accept(new ASTVisitor() {
      @Override
      public boolean visit(FieldDeclaration f) {
        if (!Modifier.isPrivate(f.getModifiers())) return false;
        for (Object o : f.fragments()) {
          VariableDeclarationFragment frag = (VariableDeclarationFragment) o;
          String name = frag.getName().getIdentifier();
          if (uses.getOrDefault(name, 0) > 1) continue;
          out.add(new Finding(UnusedPrivateField.this, frag, "Private field '" + name + "' is never used", "Remove '" + name + "'",
              rw -> rw.remove(f.fragments().size() == 1 ? f : frag, null)));
        }
        return false;
      }
    });
  }
}
